"""Insight StreamEventSink — executor observer → Redis Stream (BLF-1012).

Implements the executor's :class:`~app.services.insight.executor.InsightEventSink`
protocol on top of :class:`~app.services.insight.stream_bus.InsightStreamWriter`.
Runs **inside the Celery worker** (sync context); every method honors the
sink contract: never raise, the DB row stays authoritative.

Event mapping (all under one canonical envelope ``{run_id, attempt, seq}``):

- worker opens the run → ``snapshot`` (seq 1) from the queued row;
- every ``on_status`` → ``status`` event (aggregating/generating/finalizing
  + progress) and an updated ``snapshot`` checkpoint under the snapshot key;
- every ``on_content_delta`` → ``content.delta`` event (typewriter frames);
- ``on_terminal`` → exactly one ``done`` (completed) or ``error``
  (failed/cancelled) event, guarded by the Redis terminal marker so a
  redelivered task cannot double-emit; the closing snapshot checkpoint is
  written *before* the terminal frame so an out-of-window resume finds it.

Resume semantics (see ``subscriber.py``): the SSE id is the canonical
``{run_id}:{attempt}:{seq}``; the subscriber replays strictly after the
cursor, falling back to the snapshot checkpoint when the cursor fell out of
the retention window.
"""

from __future__ import annotations

import logging
from uuid import UUID

from app.models.insight_run import InsightRun
from app.schemas.insight import (
    InsightErrorCode,
    InsightRunDetail,
    InsightStage,
    InsightStatus,
    make_error,
)
from app.services.insight.events import (
    ContentDeltaEvent,
    DoneEvent,
    ErrorEvent,
    InsightEvent,
    SnapshotEvent,
    StatusEvent,
)
from app.services.insight.stream_bus import InsightStreamWriter

logger = logging.getLogger(__name__)


def _to_snapshot_event(
    detail: InsightRunDetail, *, attempt: int, seq: int
) -> SnapshotEvent:
    return SnapshotEvent(
        schema_version=1,
        run_id=detail.run_id,
        attempt=attempt,
        seq=seq,
        status=detail.status,
        stage=detail.stage,
        progress_percent=detail.progress_percent,
        outputs=detail.outputs,
        is_terminal=detail.status
        in (InsightStatus.COMPLETED, InsightStatus.FAILED, InsightStatus.CANCELLED),
        error=detail.error,
    )


def _to_done_event(detail: InsightRunDetail, *, attempt: int, seq: int) -> DoneEvent:
    from app.services.insight.contracts import sha256_hex

    outputs = detail.outputs
    content = ""
    for output in outputs.values():
        content = output.content
        break
    title = detail.title or None
    return DoneEvent(
        schema_version=1,
        run_id=detail.run_id,
        attempt=attempt,
        seq=seq,
        outputs=outputs,
        artifact_id=detail.artifact_id,
        title=title,
        content_sha256=sha256_hex(content.encode("utf-8")) if content else "",
        usage=detail.usage.model_dump() if detail.usage else None,
    )


class StreamEventSink:
    """Redis Stream sink for one ``execute_run`` invocation (BLF-1012).

    Constructed per attempt by the Celery task. Holds the run/attempt
    identity so each executor callback can allocate a seq and build the
    full envelope; the writer's terminal marker enforces terminal-once.
    """

    def __init__(
        self,
        *,
        writer: InsightStreamWriter,
        run_id: UUID | str,
        attempt: int,
    ) -> None:
        self._writer = writer
        self._run_id = str(run_id)
        self._attempt = attempt

    # ── lifecycle ───────────────────────────────────────────────────────

    def open(self, detail: InsightRunDetail) -> None:
        """Register cancel/seq keys and publish the opening snapshot (seq 1).

        Idempotent on redelivery: ``open_run`` keeps an allocated seq chain
        (NX), and the opening snapshot re-publishes the *current* row state,
        so a resumed delivery observes whatever progress already happened.
        """
        self._writer.open_run(self._run_id, self._attempt)
        self._publish_snapshot(detail)

    # ── executor sink protocol ──────────────────────────────────────────

    def on_status(
        self,
        run: InsightRun,
        stage: InsightStage,
        progress: int,
        detail: str | None = None,
    ) -> None:
        seq = self._writer.next_seq(self._run_id, self._attempt)
        if seq is None:
            return
        event = StatusEvent(
            schema_version=1,
            run_id=UUID(self._run_id),
            attempt=self._attempt,
            seq=seq,
            status=InsightStatus(run.status),
            stage=stage,
            progress_percent=progress,
            detail=detail,
        )
        self._writer.append_event(self._run_id, event)

    def on_content_delta(self, *, slot: str, block_id: str, delta: str) -> None:
        seq = self._writer.next_seq(self._run_id, self._attempt)
        if seq is None:
            return
        event = ContentDeltaEvent(
            schema_version=1,
            run_id=UUID(self._run_id),
            attempt=self._attempt,
            seq=seq,
            slot=slot,
            block_id=block_id,
            delta=delta,
        )
        self._writer.append_event(self._run_id, event)

    def on_terminal(self, detail: InsightRunDetail) -> None:
        """Emit the terminal event exactly once per attempt, then close.

        The terminal claim is taken *before* allocating the seq: if the
        marker is already held (redelivery raced us), this is a no-op —
        the client already received the terminal frame, and the stream's
        authoritative terminal content is the one already published.
        """
        if not self._writer.try_mark_terminal(self._run_id, self._attempt):
            return
        seq = self._writer.next_seq(self._run_id, self._attempt) or 0
        terminal: InsightEvent | None = None
        if detail.status == InsightStatus.COMPLETED:
            terminal = _to_done_event(detail, attempt=self._attempt, seq=seq)
        elif detail.status == InsightStatus.FAILED:
            terminal = ErrorEvent(
                schema_version=1,
                run_id=detail.run_id,
                attempt=self._attempt,
                seq=seq,
                status="failed",
                error=detail.error
                or make_error(InsightErrorCode.PROVIDER_UNAVAILABLE, "Insight run failed"),
            )
        elif detail.status == InsightStatus.CANCELLED:
            terminal = ErrorEvent(
                schema_version=1,
                run_id=detail.run_id,
                attempt=self._attempt,
                seq=seq,
                status="cancelled",
                error=detail.error
                or make_error(InsightErrorCode.CANCELLED, "Insight run cancelled"),
            )
        if terminal is not None:
            self._writer.save_checkpoint(
                self._run_id,
                _to_snapshot_event(detail, attempt=self._attempt, seq=seq),
            )
            self._writer.append_event(self._run_id, terminal)
        self._writer.close_run(self._run_id, self._attempt)

    # ── internal ───────────────────────────────────────────────────────

    def _publish_snapshot(self, detail: InsightRunDetail) -> None:
        seq = self._writer.next_seq(self._run_id, self._attempt)
        if seq is None:
            return
        snapshot = _to_snapshot_event(detail, attempt=self._attempt, seq=seq)
        self._writer.save_checkpoint(self._run_id, snapshot)
        self._writer.append_event(self._run_id, snapshot)

    # ── worker-side helpers (Celery task) ────────────────────────────────

    def publish_cancelled(self, detail: InsightRunDetail) -> None:
        """Emit the cancelled terminal frame when the worker observed the
        cancel request but the executor returned without a terminal
        ``on_terminal`` (the stale worker stops silently — the canceling
        session's run row is already cancelled; publish its terminal view)."""
        self.on_terminal(detail)
