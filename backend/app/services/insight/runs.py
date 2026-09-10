"""Insight durable run repository (BLF-1011).

Persistence owner for ``insight_runs``. All state changes funnel through
:func:`transition`, which enforces the Stage 1 lifecycle table
(``lifecycle.require_transition``): forward-only progress, no rollback, and
no second write once terminal. Idempotent creation is scoped by
``(project_id, country, idempotency_key)`` with a fingerprint check, so a
retried request never spawns a duplicate run or a duplicate LLM call.

:func:`to_detail` builds the authoritative snapshot consumed by the detail
endpoint and (in BLF-1012) by the SSE transport. No per-token writes happen
here — deltas flow to the event sink only.

Transaction ownership
---------------------
Every function below only flushes; the caller owns the commit. Request
scoped callers (HTTP cancel/retry, the Celery task wrapper) commit after
calling. The executor (:mod:`app.services.insight.executor`) is the
exception: each phase checkpoint commits immediately, so a worker kill
loses no progress. :func:`cancel_run` / :func:`retry_run` take a row lock
(:func:`get_run_for_update`) where the backend supports it, so a
concurrent worker checkpoint observes the cancel/retry on its next
refresh instead of overwriting it.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.insight_run import InsightRun
from app.schemas.insight import (
    InsightError,
    InsightErrorCode,
    InsightOutput,
    InsightResumeInfo,
    InsightRunDetail,
    InsightRunRequest,
    InsightStage,
    InsightStatus,
    InsightUsage,
    make_error,
)
from app.services.insight.lifecycle import (
    is_terminal,
    next_attempt,
    require_retryable,
    require_transition,
)


class RunNotFound(Exception):
    """No ``insight_runs`` row for the requested run_id."""

    def __init__(self, run_id: UUID | str) -> None:
        self.run_id = str(run_id)
        super().__init__(f"insight run not found: {run_id}")


class IdempotencyConflict(Exception):
    """Same scope + key but a different request fingerprint."""

    def __init__(self, existing: InsightRun) -> None:
        self.existing = existing
        super().__init__(
            "idempotency key already used by a different insight request"
        )


def _utcnow_naive() -> datetime:
    """Naive UTC now: comparable with DB-returned datetimes on any backend."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _as_naive_utc(value: datetime) -> datetime:
    if value.tzinfo is not None:
        return value.astimezone(timezone.utc).replace(tzinfo=None)
    return value


def _timeline_of(run: InsightRun) -> list[dict[str, Any]]:
    try:
        entries = json.loads(run.status_timeline_json or "[]")
    except (TypeError, ValueError):
        entries = []
    return entries if isinstance(entries, list) else []


def _append_timeline(run: InsightRun, status: InsightStatus, attempt: int) -> None:
    entries = _timeline_of(run)
    entries.append(
        {
            "status": status.value,
            "attempt": attempt,
            "at": _utcnow_naive().isoformat(timespec="seconds") + "Z",
        }
    )
    run.status_timeline_json = json.dumps(entries)


def _find_by_scope_key(
    db: Session, *, project_id: int, country: str, idempotency_key: str
) -> InsightRun | None:
    return db.scalar(
        select(InsightRun).where(
            InsightRun.project_id == project_id,
            InsightRun.country == country,
            InsightRun.idempotency_key == idempotency_key,
        )
    )


def create_run(
    db: Session,
    *,
    request: InsightRunRequest,
    fingerprint: str,
    endpoint_id: str,
    model_id: str,
    capability: str = "insight",
) -> tuple[InsightRun, bool]:
    """Insert a queued run, or replay the existing one for the same key.

    Returns ``(run, replayed)``. A fingerprint mismatch raises
    :class:`IdempotencyConflict`. The unique scope/key constraint is the
    backstop for concurrent inserts: the loser re-reads and replays.
    """

    existing = _find_by_scope_key(
        db,
        project_id=request.project_id,
        country=request.country,
        idempotency_key=request.idempotency_key,
    )
    if existing is not None:
        if existing.request_fingerprint == fingerprint:
            return existing, True
        raise IdempotencyConflict(existing)

    run = InsightRun(
        run_id=str(uuid4()),
        attempt=1,
        capability=capability,
        use_case=f"{request.role_id}.v{request.role_version}",
        project_id=request.project_id,
        country=request.country,
        role_id=request.role_id,
        role_version=request.role_version,
        endpoint_id=endpoint_id,
        model_id=model_id,
        status=InsightStatus.QUEUED.value,
        stage=InsightStage.QUEUED.value,
        progress_percent=0,
        idempotency_key=request.idempotency_key,
        request_fingerprint=fingerprint,
        slots_json=json.dumps(request.slots, ensure_ascii=False, sort_keys=True),
        status_timeline_json="[]",
    )
    _append_timeline(run, InsightStatus.QUEUED, 1)
    db.add(run)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raced = _find_by_scope_key(
            db,
            project_id=request.project_id,
            country=request.country,
            idempotency_key=request.idempotency_key,
        )
        if raced is not None:
            if raced.request_fingerprint == fingerprint:
                return raced, True
            raise IdempotencyConflict(raced) from None
        raise
    db.refresh(run)
    return run, False


def _normalize_run_id(run_id: UUID | str) -> str:
    try:
        return str(UUID(str(run_id)))
    except (ValueError, AttributeError, TypeError):
        raise RunNotFound(run_id) from None


def get_run(db: Session, run_id: UUID | str) -> InsightRun:
    """Load a run by public run_id; unknown (or malformed) id → RunNotFound."""
    normalized = _normalize_run_id(run_id)
    run = db.scalar(select(InsightRun).where(InsightRun.run_id == normalized))
    if run is None:
        raise RunNotFound(run_id)
    return run


def get_run_for_update(db: Session, run_id: UUID | str) -> InsightRun:
    """Load a run with a write lock where the backend supports it (Postgres).

    SQLite (tests / local dev) takes no lock — the executor's refresh
    guards provide the stale-write protection there instead. Callers must
    commit (or roll back) promptly to release the lock.
    """
    normalized = _normalize_run_id(run_id)
    stmt = select(InsightRun).where(InsightRun.run_id == normalized)
    try:
        bind = db.get_bind()
        dialect = bind.dialect.name if bind is not None else ""
    except Exception:  # noqa: BLE001 — best-effort capability probe
        dialect = ""
    if dialect and dialect != "sqlite":
        stmt = stmt.with_for_update()
    run = db.scalar(stmt)
    if run is None:
        raise RunNotFound(run_id)
    return run


def transition(
    db: Session,
    run: InsightRun,
    to: InsightStatus,
    *,
    stage: InsightStage | None = None,
    progress: int | None = None,
    usage: InsightUsage | None = None,
    outputs: dict[str, InsightOutput] | None = None,
    content: str | None = None,
    error: InsightError | None = None,
) -> InsightRun:
    """Move a run forward; illegal rollback or terminal re-write raises.

    Flush-only: the caller owns the commit (see module docstring for the
    full transaction policy). Terminal transitions stamp
    ``completed_at``/``duration_ms`` exactly once — a second call raises
    ``RUN_TERMINAL`` instead of overwriting.
    """

    current = InsightStatus(run.status)
    require_transition(current, to)

    now = _utcnow_naive()
    if run.started_at is None and current == InsightStatus.QUEUED:
        run.started_at = now
    run.status = to.value
    if stage is not None:
        run.stage = stage.value
    if progress is not None:
        run.progress_percent = progress
    if usage is not None:
        run.usage_json = usage.model_dump_json()
    if outputs is not None:
        run.outputs_json = json.dumps(
            {slot: output.model_dump(mode="json") for slot, output in outputs.items()}
        )
    if content is not None:
        run.content_markdown = content
    if error is not None:
        run.error_json = error.model_dump_json()
    if is_terminal(to):
        run.completed_at = now
        started = run.started_at if run.started_at is not None else now
        run.duration_ms = int(
            (_as_naive_utc(now) - _as_naive_utc(started)).total_seconds() * 1000
        )
    _append_timeline(run, to, run.attempt)
    db.flush()
    return run


def cancel_run(db: Session, run_id: UUID | str) -> tuple[InsightRun, bool]:
    """Cancel a run; already terminal → ``(run, True)`` without touching it.

    Takes a row lock where supported; callers must commit promptly.
    """

    run = get_run_for_update(db, run_id)
    if is_terminal(InsightStatus(run.status)):
        return run, True
    transition(
        db,
        run,
        InsightStatus.CANCELLED,
        progress=run.progress_percent,
        error=make_error(InsightErrorCode.CANCELLED, "Insight run cancelled"),
    )
    return run, False


def retry_run(db: Session, run_id: UUID | str) -> InsightRun:
    """Bump a failed/cancelled run to a fresh queued attempt on the same row.

    Only failed/cancelled runs are retryable (completed → RUN_TERMINAL,
    active → INVALID_STATE_TRANSITION). The new attempt reuses the stored
    slots; terminal artifacts of the previous attempt are cleared. Takes a
    row lock where supported; callers must commit promptly.
    """

    run = get_run_for_update(db, run_id)
    require_retryable(InsightStatus(run.status))
    run.attempt = next_attempt(run.attempt)
    run.status = InsightStatus.QUEUED.value
    run.stage = InsightStage.QUEUED.value
    run.progress_percent = 0
    run.usage_json = None
    run.outputs_json = None
    run.content_markdown = None
    run.error_json = None
    run.started_at = None
    run.completed_at = None
    run.duration_ms = None
    _append_timeline(run, InsightStatus.QUEUED, run.attempt)
    db.flush()
    return run


def _parse_outputs(raw: str | None) -> dict[str, InsightOutput]:
    if not raw:
        return {}
    return {
        slot: InsightOutput.model_validate(payload)
        for slot, payload in json.loads(raw).items()
    }


def to_detail(run: InsightRun) -> InsightRunDetail:
    """Authoritative snapshot for the detail endpoint and SSE transport."""

    now = _utcnow_naive()
    return InsightRunDetail(
        schema_version=1,
        run_id=UUID(run.run_id),
        attempt=run.attempt,
        role_id=run.role_id,
        role_version=run.role_version,
        project_id=run.project_id,
        country=run.country,  # type: ignore[arg-type]
        status=InsightStatus(run.status),
        stage=InsightStage(run.stage),
        progress_percent=run.progress_percent,
        outputs=_parse_outputs(run.outputs_json),
        usage=InsightUsage.model_validate_json(run.usage_json)
        if run.usage_json
        else None,
        error=InsightError.model_validate_json(run.error_json)
        if run.error_json
        else None,
        resume=InsightResumeInfo(
            latest_event_id=None,
            current_attempt=run.attempt,
            history_available=False,
        ),
        created_at=_as_naive_utc(run.created_at).replace(tzinfo=timezone.utc)
        if run.created_at is not None
        else now.replace(tzinfo=timezone.utc),
        started_at=_as_naive_utc(run.started_at).replace(tzinfo=timezone.utc)
        if run.started_at is not None
        else None,
        completed_at=_as_naive_utc(run.completed_at).replace(tzinfo=timezone.utc)
        if run.completed_at is not None
        else None,
        updated_at=_as_naive_utc(run.updated_at).replace(tzinfo=timezone.utc)
        if run.updated_at is not None
        else now.replace(tzinfo=timezone.utc),
    )


__all__ = [
    "IdempotencyConflict",
    "RunNotFound",
    "cancel_run",
    "create_run",
    "get_run",
    "get_run_for_update",
    "retry_run",
    "to_detail",
    "transition",
]
