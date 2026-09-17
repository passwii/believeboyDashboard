"""Insight durable run repository (BLF-1011).

Persistence owner for ``insight_runs``. All state changes funnel through
:func:`try_transition` / :func:`transition`, which enforce the Stage 1
lifecycle table (``lifecycle.require_transition``): forward-only progress,
no rollback, and no second write once terminal. Idempotent creation is
scoped by ``(project_id, country, idempotency_key)`` with a fingerprint
check, so a retried request never spawns a duplicate run or a duplicate
LLM call.

:func:`to_detail` builds the authoritative snapshot consumed by the detail
endpoint and (in BLF-1012) by the SSE transport. No per-token writes happen
here — deltas flow to the event sink only.

Atomic state writes
-------------------
Every state change is a compare-and-swap ``UPDATE`` carrying its own
precondition (``id`` + ``attempt`` + the row's status being a legal source
for the target). A writer that lost its claim — the run was cancelled, the
attempt was bumped by an explicit retry, or the phase was already advanced
by a redelivered sibling — matches no row and gets ``False`` instead of
clobbering the newer state. State is therefore never decided by a read
that a competing writer can overtake before the write is sent, which is
what makes the guard atomic on every backend (Postgres row locks and
SQLite alike).

Transaction ownership
---------------------
State writes go through the session's own ``UPDATE``; request-scoped
callers own the commit. The executor
(:mod:`app.services.insight.executor`) is the exception: each phase
checkpoint commits immediately, so a worker kill loses no progress.
:func:`cancel_run` / :func:`retry_run` take a row lock
(:func:`get_run_for_update`) where the backend supports it and re-target
the live attempt when the CAS loses; the CAS is the actual backstop, the
lock only reduces contention.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import func, select, update
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
    can_retry,
    is_terminal,
    next_attempt,
    require_retryable,
    require_transition,
    sources_of,
)

logger = logging.getLogger(__name__)


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


class StaleRunWrite(Exception):
    """A state write lost its claim and was not applied.

    Raised by the strict :func:`transition` entry point when the row is no
    longer the one the caller read: another session cancelled it, parked it
    terminal, or bumped ``attempt`` (explicit retry). Callers that mean "if
    I still own it" use :func:`try_transition` instead.
    """

    def __init__(self, run: InsightRun, expected_attempt: int) -> None:
        self.run_id = run.run_id
        self.expected_attempt = expected_attempt
        self.attempt = run.attempt
        self.status = run.status
        super().__init__(
            f"insight run {run.run_id} no longer belongs to attempt "
            f"{expected_attempt} (current status={run.status}, "
            f"attempt={run.attempt})"
        )


def _utcnow() -> datetime:
    """Aware UTC now — the only shape safe to write into a ``timestamptz``.

    ``insight_runs``/``insight_run_observations`` 的时间列是
    ``TIMESTAMP WITH TIME ZONE``。naive 值交给 Postgres 会按**会话时区**解释，
    而本地与生产 VPS 的会话时区都是 ``Asia/Shanghai``：naive UTC 因此被存成
    8 小时前的瞬时，派生出的 ``duration_ms`` / ``first_delta_ms`` 全部 +8h
    （BLF-1111，门禁据此误报未达标）。aware 值自带瞬时，不受会话时区影响。
    """
    return datetime.now(timezone.utc)


def _as_utc(value: datetime) -> datetime:
    """DB-returned datetime → aware UTC, whatever the backend hands back.

    Postgres 回 aware；SQLite（单测 / 本地）丢偏移量回 naive UTC——两者都归一到
    同一瞬时，所以 naive 只在这里被**解释**，不再被写出去。
    """
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _timeline_of(run: InsightRun) -> list[dict[str, Any]]:
    try:
        entries = json.loads(run.status_timeline_json or "[]")
    except (TypeError, ValueError):
        entries = []
    return entries if isinstance(entries, list) else []


def _timeline_entry(
    status: InsightStatus, attempt: int, now: datetime
) -> dict[str, Any]:
    return {
        "status": status.value,
        "attempt": attempt,
        # 时间线对外固定 UTC ``...Z`` 形式：先归一成 UTC 再去掉偏移量，避免 aware
        # 值序列化出 ``+00:00Z`` 这种双重标注。
        "at": _as_utc(now).replace(tzinfo=None).isoformat(timespec="seconds") + "Z",
    }


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
        # 首条时间线与行本身在同一次 INSERT 里落库，建行即处于终态之外的确定
        # 状态；此后的每次状态变更都是 CAS UPDATE（见 try_transition）。
        status_timeline_json=json.dumps(
            [_timeline_entry(InsightStatus.QUEUED, 1, _utcnow())]
        ),
    )
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

    SQLite (tests / local dev) takes no lock — the compare-and-swap state
    writes provide the stale-write protection there instead, so the lock
    only reduces contention, never correctness. Callers must commit (or
    roll back) promptly to release the lock.
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


def _timeline_json(
    run: InsightRun, to: InsightStatus, attempt: int, now: datetime
) -> str:
    return json.dumps(_timeline_of(run) + [_timeline_entry(to, attempt, now)])


def _cas_write(
    db: Session,
    *,
    run: InsightRun,
    expected_attempt: int,
    values: dict[str, Any],
    expected_statuses: frozenset[InsightStatus],
) -> bool:
    """Compare-and-swap one row: ``True`` iff this writer still owned it.

    The precondition travels with the write (``id`` + ``attempt`` + status in
    the legal source set), so the database evaluates it against the row it is
    about to overwrite — not against a snapshot a competing session can
    overtake before the statement is sent. On a miss the in-memory ``run`` is
    refreshed with the winner's state, so callers can report what actually
    happened; the ORM is never flushed to satisfy a stale object.
    """

    stmt = (
        update(InsightRun)
        .where(
            InsightRun.id == run.id,
            InsightRun.attempt == expected_attempt,
            InsightRun.status.in_(sorted(status.value for status in expected_statuses)),
        )
        .values(**values)
        .execution_options(synchronize_session=False)
    )
    with db.no_autoflush:
        applied = db.execute(stmt).rowcount == 1
        db.refresh(run)
    return applied


def try_transition(
    db: Session,
    run: InsightRun,
    to: InsightStatus,
    *,
    expected_attempt: int,
    stage: InsightStage | None = None,
    progress: int | None = None,
    usage: InsightUsage | None = None,
    outputs: dict[str, InsightOutput] | None = None,
    content: str | None = None,
    error: InsightError | None = None,
) -> bool:
    """Move a run forward only if it still is ``expected_attempt``'s to move.

    Returns ``False`` — without writing — when another session already
    cancelled the run, parked it terminal, or bumped ``attempt`` (explicit
    retry): a stale worker must never resurrect its own snapshot. Terminal
    transitions stamp ``completed_at``/``duration_ms`` in the same statement,
    so a run cannot be completed twice.

    Flush-only in the sense that the caller owns the commit (see the module
    docstring): the ``UPDATE`` is issued here, the transaction stays open.
    """

    now = _utcnow()
    values: dict[str, Any] = {
        "status": to.value,
        "updated_at": now,
        "status_timeline_json": _timeline_json(run, to, expected_attempt, now),
    }
    if stage is not None:
        values["stage"] = stage.value
    if progress is not None:
        values["progress_percent"] = progress
    if usage is not None:
        values["usage_json"] = usage.model_dump_json()
    if outputs is not None:
        values["outputs_json"] = json.dumps(
            {slot: output.model_dump(mode="json") for slot, output in outputs.items()}
        )
    if content is not None:
        values["content_markdown"] = content
    if error is not None:
        values["error_json"] = error.model_dump_json()
    # First checkpoint of an attempt starts the clock; retry cleared it, and
    # coalesce keeps an already-stamped start when a redelivery re-writes.
    if run.started_at is None:
        values["started_at"] = func.coalesce(InsightRun.started_at, now)
    if is_terminal(to):
        values["completed_at"] = now
        values["duration_ms"] = (
            0
            if run.started_at is None
            else max(
                0,
                int(
                    (
                        now - _as_utc(run.started_at)
                    ).total_seconds()
                    * 1000
                ),
            )
        )
    return _cas_write(
        db,
        run=run,
        expected_attempt=expected_attempt,
        values=values,
        expected_statuses=sources_of(to),
    )


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
    """Move a run forward; illegal rollback, terminal re-write, or a lost
    claim raises.

    Raises :class:`~app.services.insight.lifecycle.LifecycleError` when the
    caller's own snapshot makes the move illegal, and
    :class:`StaleRunWrite` when the row moved under it (another session
    cancelled it, parked it terminal, or bumped ``attempt``). Flush-only: the
    caller owns the commit. Use :func:`try_transition` when losing the claim
    is expected rather than an error.
    """

    expected_attempt = run.attempt
    require_transition(InsightStatus(run.status), to)
    if not try_transition(
        db,
        run,
        to,
        expected_attempt=expected_attempt,
        stage=stage,
        progress=progress,
        usage=usage,
        outputs=outputs,
        content=content,
        error=error,
    ):
        raise StaleRunWrite(run, expected_attempt)
    return run


#: cancel/retry re-target the live attempt at most this many times before
#: giving up; the row lock already serializes writers on Postgres.
_CAS_ROUNDS = 3


def cancel_run(db: Session, run_id: UUID | str) -> tuple[InsightRun, bool]:
    """Cancel a run; already terminal → ``(run, True)`` without touching it.

    Cancel targets the *run*, not the attempt the caller happened to read: if
    a concurrent cancel+retry already moved the row to a newer queued
    attempt, that attempt is what gets cancelled. Takes a row lock where
    supported; callers must commit promptly.
    """

    run = get_run_for_update(db, run_id)
    for _ in range(_CAS_ROUNDS):
        if is_terminal(InsightStatus(run.status)):
            return run, True
        expected_attempt = run.attempt
        if try_transition(
            db,
            run,
            InsightStatus.CANCELLED,
            expected_attempt=expected_attempt,
            progress=run.progress_percent,
            error=make_error(InsightErrorCode.CANCELLED, "Insight run cancelled"),
        ):
            return run, False
        # Lost the CAS: re-read the live row (try_transition refreshed it) and
        # decide again — terminal is a no-op, a newer attempt is the target.
        run = get_run_for_update(db, run_id)
    raise StaleRunWrite(run, expected_attempt)


def retry_run(db: Session, run_id: UUID | str) -> InsightRun:
    """Bump a failed/cancelled run to a fresh queued attempt on the same row.

    Only failed/cancelled runs are retryable (completed → RUN_TERMINAL,
    active → INVALID_STATE_TRANSITION). The new attempt reuses the stored
    slots; terminal artifacts of the previous attempt are cleared. Takes a
    row lock where supported; callers must commit promptly.
    """

    run = get_run_for_update(db, run_id)
    for _ in range(_CAS_ROUNDS):
        current = InsightStatus(run.status)
        require_retryable(current)
        expected_attempt = run.attempt
        now = _utcnow()
        attempt = next_attempt(run.attempt)
        if _cas_write(
            db,
            run=run,
            expected_attempt=expected_attempt,
            expected_statuses=frozenset(
                status for status in InsightStatus if can_retry(status)
            ),
            values={
                "attempt": attempt,
                "status": InsightStatus.QUEUED.value,
                "stage": InsightStage.QUEUED.value,
                "progress_percent": 0,
                "usage_json": None,
                "outputs_json": None,
                "content_markdown": None,
                "error_json": None,
                "started_at": None,
                "completed_at": None,
                "duration_ms": None,
                "updated_at": now,
                # 新 attempt 重新计时：旧 attempt 的 queued 之后才算开始。
                "status_timeline_json": _timeline_json(
                    run, InsightStatus.QUEUED, attempt, now
                ),
            },
        ):
            return run
        # Lost the CAS: re-read (already refreshed) and re-decide on the live
        # attempt — a concurrent cancel/retry is not an error for the caller.
        run = get_run_for_update(db, run_id)
    raise StaleRunWrite(run, expected_attempt)


def _parse_outputs(raw: str | None) -> dict[str, InsightOutput]:
    if not raw:
        return {}
    return {
        slot: InsightOutput.model_validate(payload)
        for slot, payload in json.loads(raw).items()
    }


def to_detail(run: InsightRun) -> InsightRunDetail:
    """Authoritative snapshot for the detail endpoint and SSE transport."""

    now = _utcnow()
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
        created_at=_as_utc(run.created_at)
        if run.created_at is not None
        else now,
        started_at=_as_utc(run.started_at)
        if run.started_at is not None
        else None,
        completed_at=_as_utc(run.completed_at)
        if run.completed_at is not None
        else None,
        updated_at=_as_utc(run.updated_at)
        if run.updated_at is not None
        else now,
    )


__all__ = [
    "IdempotencyConflict",
    "RunNotFound",
    "StaleRunWrite",
    "cancel_run",
    "create_run",
    "get_run",
    "get_run_for_update",
    "retry_run",
    "to_detail",
    "transition",
    "try_transition",
]
