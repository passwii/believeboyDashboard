"""Insight run endpoints — durable runs + Redis Stream SSE (BLF-1012).

HTTP surface of the new Insight infrastructure (BLF-1005 Stage 2):

- ``POST /insight/runs`` — validate (Stage 1 contract), idempotently create,
  enqueue; returns the run envelope with detail/stream/cancel/retry URLs.
- ``GET /insight/runs/{run_id}`` — authoritative snapshot from the DB row;
  always available, even when Redis is not.
- ``GET /insight/runs/{run_id}/stream`` — SSE over the Redis Stream
  transport: replayable (Last-Event-ID), cancellable, resumable.
- ``POST /insight/runs/{run_id}/cancel`` — cancel the run (DB is
  authoritative) and consume the stream cancel registry.
- ``POST /insight/runs/{run_id}/retry`` — bump attempt, re-enqueue.

Legacy ``/ai-insights/*`` (old module) is untouched — acceptance §5.

Permission model: same as the legacy module — ``protected`` (API key via the
Next proxy) + project-scoped access check via ``project_service`` for every
run the caller touches.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.api.deps import (
    get_primary_db_session,
    get_read_db_session,
    get_request_is_admin,
    get_request_operator,
    protected,
)
from app.schemas.insight import (
    ERROR_HTTP_STATUS,
    InsightError,
    InsightErrorCode,
    InsightRunActionResponse,
    InsightRunDetail,
    InsightRunResponse,
    make_error,
)
from app.services import project_service
from app.services.insight import stream_bus
from app.services.insight.cursor import CursorError, check_future_cursor, parse_event_id
from app.services.insight.events import InsightEvent
from app.services.insight.executor import (
    IdempotencyConflict,
    RoleLookupError,
    RunNotFound,
    StaleRunWrite,
    map_provider_error,
    start_run,
)
from app.services.insight.lifecycle import LifecycleError
from app.services.insight.provider import InsightProviderError
from app.services.insight.runs import cancel_run, get_run, retry_run, to_detail
from app.services.insight.stream_bus import InsightStreamWriter
from app.services.insight.subscriber import (
    InsightStreamSubscriber,
    TransportUnavailableError,
)
from app.services.insight.validator import InsightValidationError, ScopeError

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/insight/runs", tags=["insight"], dependencies=[Depends(protected)]
)


def _run_urls(run_id: UUID | str) -> dict[str, str]:
    """Relative product URLs only — no host, no scheme, no key material."""
    rid = str(run_id)
    return {
        "detail_url": f"/api/v1/insight/runs/{rid}",
        "stream_url": f"/api/v1/insight/runs/{rid}/stream",
        "cancel_url": f"/api/v1/insight/runs/{rid}/cancel",
        "retry_url": f"/api/v1/insight/runs/{rid}/retry",
    }


def _as_utc(value: datetime | None) -> datetime:
    """DB naive UTC → aware UTC (same convention as ``runs.to_detail``)."""
    if value is None:
        return datetime.now(timezone.utc)
    if value.tzinfo is not None:
        return value.astimezone(timezone.utc)
    return value.replace(tzinfo=timezone.utc)


def _to_run_response(run: Any, *, replayed: bool = False) -> InsightRunResponse:
    from app.schemas.insight import InsightStatus

    return InsightRunResponse(
        schema_version=1,
        run_id=UUID(run.run_id),
        attempt=run.attempt,
        role_id=run.role_id,
        role_version=run.role_version,
        project_id=run.project_id,
        country=run.country,  # type: ignore[arg-type]
        status=InsightStatus(run.status),  # type: ignore[arg-type]
        output_format="markdown",
        **_run_urls(run.run_id),
        replayed=replayed,
        created_at=_as_utc(run.created_at),
        updated_at=_as_utc(run.updated_at),
    )


def _ensure_run_access(db: Session, run: Any, operator: str | None, is_admin: bool) -> None:
    """Project-scoped access for any run the caller touches (legacy parity)."""
    project_service.ensure_project_access(
        db, run.project_id, operator=operator, is_admin=is_admin
    )


def _load_run_or_404(db: Session, run_id: UUID) -> Any:
    try:
        return get_run(db, run_id)
    except RunNotFound:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": InsightErrorCode.RUN_NOT_FOUND.value},
        ) from None


async def _json_body(request: Request) -> dict[str, Any]:
    """Parse the request body once; JSON errors map to INVALID_REQUEST."""
    try:
        raw = await request.json()
    except Exception:  # noqa: BLE001 — json() raises assorted parser errors
        raise _typed_error(
            make_error(InsightErrorCode.INVALID_REQUEST, "Request body must be JSON")
        ) from None
    if not isinstance(raw, dict):
        raise _typed_error(
            make_error(
                InsightErrorCode.INVALID_REQUEST,
                "Request body must be a JSON object",
            )
        )
    return raw


def _typed_error(error: InsightError) -> HTTPException:
    """Typed Insight error → HTTPException with the contract's fixed status."""
    return HTTPException(
        status_code=ERROR_HTTP_STATUS.get(
            error.code, status.HTTP_500_INTERNAL_SERVER_ERROR
        ),
        detail={
            "code": error.code.value,
            "message": error.message,
            "retryable": bool(error.retryable),
        },
    )


def _scope_authorizer(db: Session, *, operator: str | None, is_admin: bool) -> Any:
    """Wrap ``project_service`` into the validator's ScopeAuthorizer callable.

    Project missing → PROJECT_NOT_FOUND; no access → PROJECT_OUT_OF_SCOPE;
    country mismatch → COUNTRY_MISMATCH. ``ensure_project_access`` raising
    HTTPException is translated into the ScopeError the validator expects.
    """
    def authorizer(project_id: int, country: str) -> None:
        try:
            row = project_service.ensure_project_access(
                db, project_id, operator=operator, is_admin=is_admin
            )
        except HTTPException as exc:
            if exc.status_code == 404:
                raise ScopeError(
                    InsightErrorCode.PROJECT_NOT_FOUND, "Project not found"
                ) from None
            raise ScopeError(
                InsightErrorCode.PROJECT_OUT_OF_SCOPE, "Project out of scope"
            ) from None
        if row.country != country:
            raise ScopeError(
                InsightErrorCode.COUNTRY_MISMATCH,
                f"Project country is {row.country}, requested {country}",
            )

    return authorizer


@router.post("", response_model=InsightRunResponse, status_code=status.HTTP_201_CREATED)
async def create_insight_run(
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Depends(get_request_is_admin),
) -> InsightRunResponse:
    """Create (or replay) a durable Insight run and enqueue the Celery task."""

    raw = await _json_body(request)
    authorizer = _scope_authorizer(db, operator=operator, is_admin=is_admin)
    try:
        from app.celery_tasks.insights.run import enqueue_insight_run

        run, replayed = start_run(
            db=db,
            raw=raw,
            scope_authorizer=authorizer,
            enqueue=enqueue_insight_run,
        )
    except InsightValidationError as exc:
        raise _typed_error(exc.error) from None
    except RoleLookupError as exc:
        raise _typed_error(make_error(exc.code, str(exc))) from None
    except ScopeError as exc:
        raise _typed_error(make_error(exc.code, "Request scope rejected")) from None
    except InsightProviderError as exc:
        raise _typed_error(map_provider_error(exc)) from None
    except IdempotencyConflict:
        raise _typed_error(
            make_error(
                InsightErrorCode.IDEMPOTENCY_KEY_CONFLICT,
                "Idempotency key already used with a different payload",
            )
        ) from None

    return _to_run_response(run, replayed=replayed)


@router.get("/{run_id}", response_model=InsightRunDetail)
def get_insight_run(
    run_id: UUID,
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Depends(get_request_is_admin),
) -> InsightRunDetail:
    """Authoritative run snapshot — page reopen, SSE expiry, post-completion."""
    run = _load_run_or_404(db, run_id)
    _ensure_run_access(db, run, operator, is_admin)
    return to_detail(run)


@router.get("/{run_id}/stream")
async def stream_insight_run(
    run_id: UUID,
    request: Request,
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Depends(get_request_is_admin),
    last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
):
    """SSE stream of one run's events; replayable via Last-Event-ID.

    A client disconnect does NOT cancel the run — the durable executor keeps
    running; only the explicit cancel endpoint does (acceptance §3).

    Redis outage surfaces as a typed retryable 503 *before* the stream
    starts (review B3): the client's existing HTTP-error backoff path then
    retries, and the run itself is unaffected — the detail endpoint stays
    the authority. No in-stream ``failed`` frame is ever emitted for a
    transport problem.
    """
    run = _load_run_or_404(db, run_id)
    _ensure_run_access(db, run, operator, is_admin)
    detail = to_detail(run)

    # Validate the cursor up front: malformed or pointing at a future
    # attempt → typed 400, never a mid-stream death or silent full replay.
    if last_event_id is not None:
        try:
            parsed = parse_event_id(last_event_id)
            check_future_cursor(parsed, detail.attempt)
        except CursorError as exc:
            raise _typed_error(
                make_error(
                    InsightErrorCode.RESUME_CURSOR_INVALID,
                    f"Last-Event-ID '{last_event_id}' is not a valid cursor ({exc})",
                )
            ) from None

    # Transport probe (with ping) before committing to the 200 stream: an
    # outage here is an ordinary typed 503 the client can retry.
    try:
        redis = await stream_bus.make_async_stream_client()
    except Exception as exc:  # noqa: BLE001 — redis-py raises assorted
        logger.warning("Insight stream transport unavailable: %s", exc)
        raise _typed_error(
            make_error(
                InsightErrorCode.PROVIDER_UNAVAILABLE,
                "Insight stream transport is unavailable; retry shortly",
            )
        ) from None

    subscriber = InsightStreamSubscriber(redis)

    # DB refresh on idle ticks: the sync SQLAlchemy session runs in a
    # worker thread so the event loop never blocks on I/O.
    loop = asyncio.get_running_loop()

    def _sync_loader(rid: UUID) -> InsightRunDetail | None:
        try:
            return to_detail(get_run(db, rid))
        except Exception:  # noqa: BLE001 — loader is best-effort
            return None

    async def _loader(rid: UUID) -> InsightRunDetail | None:
        return await loop.run_in_executor(None, _sync_loader, rid)

    subscriber.bind_detail_loader(_loader)

    async def event_source():
        try:
            async for event, sse_id in subscriber.subscribe(
                run_id=run_id,
                last_event_id=last_event_id,
                detail=detail,
            ):
                if await request.is_disconnected():
                    return
                yield _sse_frame(event, sse_id)
        except TransportUnavailableError as exc:
            # Mid-stream outage: the connection drops (no terminal frame —
            # the run is NOT failed); the client's reconnect-with-cursor
            # path takes over and the detail endpoint stays authoritative.
            logger.warning("Insight stream transport dropped: %s", exc)
            return
        except Exception:  # stream death must be visible; client reconnects
            logger.exception("Insight stream %s crashed", run_id)
            return

    return StreamingResponse(
        event_source(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@router.post("/{run_id}/cancel", response_model=InsightRunActionResponse)
def cancel_insight_run(
    run_id: UUID,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Depends(get_request_is_admin),
) -> InsightRunActionResponse:
    """Cancel the run: DB row is authoritative; stream registry consumed."""
    run = _load_run_or_404(db, run_id)
    _ensure_run_access(db, run, operator, is_admin)
    try:
        run, already_terminal = cancel_run(db, run_id)
        db.commit()
    except StaleRunWrite:
        db.rollback()
        raise _typed_error(
            make_error(
                InsightErrorCode.INVALID_STATE_TRANSITION,
                "Run moved concurrently; retry the cancel",
            )
        ) from None

    # Best-effort: consume the cancel registry so the stream reflects the
    # cancel immediately; the DB row already decided the outcome.
    try:
        InsightStreamWriter().request_cancel(run.run_id)
    except Exception:  # noqa: BLE001
        logger.warning("Insight cancel registry consume degraded run=%s", run_id)

    return InsightRunActionResponse(
        schema_version=1,
        run_id=UUID(run.run_id),
        attempt=run.attempt,
        status=run.status,  # type: ignore[arg-type]
        detail_url=_run_urls(run.run_id)["detail_url"],
        stream_url=_run_urls(run.run_id)["stream_url"],
        replayed=already_terminal,
    )


@router.post("/{run_id}/retry", response_model=InsightRunActionResponse)
def retry_insight_run(
    run_id: UUID,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Depends(get_request_is_admin),
) -> InsightRunActionResponse:
    """Bump the attempt on a failed/cancelled run and re-enqueue it."""
    run = _load_run_or_404(db, run_id)
    _ensure_run_access(db, run, operator, is_admin)
    try:
        run = retry_run(db, run_id)
        db.commit()
    except LifecycleError as exc:
        db.rollback()
        raise _typed_error(make_error(exc.code, str(exc))) from None
    except StaleRunWrite:
        db.rollback()
        raise _typed_error(
            make_error(
                InsightErrorCode.INVALID_STATE_TRANSITION,
                "Run moved concurrently; retry later",
            )
        ) from None

    # B1: the stream key is per-run; drop the previous attempt's frames
    # so a fresh subscribe after retry sees only the new attempt. Best-effort
    # — the subscriber's attempt filter is the second guard.
    try:
        InsightStreamWriter().reset_run(run.run_id)
    except Exception:  # noqa: BLE001 — transport reset must not fail retry
        logger.warning("Insight stream reset degraded run=%s", run_id)

    from app.celery_tasks.insights.run import enqueue_insight_run

    enqueue_insight_run(run.run_id, run.attempt)
    return InsightRunActionResponse(
        schema_version=1,
        run_id=UUID(run.run_id),
        attempt=run.attempt,
        status=run.status,  # type: ignore[arg-type]
        detail_url=_run_urls(run.run_id)["detail_url"],
        stream_url=_run_urls(run.run_id)["stream_url"],
    )


def _sse_frame(event: InsightEvent, sse_id: str | None = None) -> bytes:
    """Standard SSE frame: ``id:`` + JSON ``data:`` + blank line."""
    payload = event.model_dump_json()
    if sse_id:
        return f"id: {sse_id}\ndata: {payload}\n\n".encode()
    return f"data: {payload}\n\n".encode()


__all__ = ["router"]
