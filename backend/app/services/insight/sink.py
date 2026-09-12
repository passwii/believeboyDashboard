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
from datetime import datetime, timezone
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
from app.services.insight.stream_bus import (
    METRIC_FIRST_DELTA_MS,
    InsightStreamWriter,
)

logger = logging.getLogger(__name__)


def _as_aware(value: datetime | None) -> datetime | None:
    """首字时延的锚点统一成 aware UTC。

    run 行的 ``started_at`` 在 DB 里是 naive UTC（``_utcnow_naive``），而
    ``InsightRunDetail.started_at`` 是 aware；两处都归一化，避免相减时
    naive/aware 混用被静默跳过（BLF-1018 观测期：这个指标不能悄悄丢）。
    """
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


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
        # 首字时延的起点 = run 行 started_at（attempt 真实起点，跨 worker 重投
        # 仍一致）；只在第一个 content.delta 上记一次（BLF-1018）。
        self._started_at: datetime | None = None
        self._first_delta_recorded = False

    # ── lifecycle ───────────────────────────────────────────────────────

    def open(self, detail: InsightRunDetail) -> None:
        """Register cancel/seq keys and publish the opening snapshot (seq 1).

        Idempotent on redelivery: ``open_run`` keeps an allocated seq chain
        (NX), and the opening snapshot re-publishes the *current* row state,
        so a resumed delivery observes whatever progress already happened.
        """
        self._writer.open_run(self._run_id, self._attempt)
        self._started_at = _as_aware(detail.started_at)
        self._publish_snapshot(detail)

    # ── executor sink protocol ──────────────────────────────────────────

    def on_status(
        self,
        run: InsightRun,
        stage: InsightStage,
        progress: int,
        detail: str | None = None,
    ) -> None:
        # 首字时延的锚点在这里补齐：task 在 execute_run **之前** 就 open()，
        # 那一刻 run 还是 queued（started_at 为空），锚点只能等第一次 phase
        # checkpoint（``started_at`` 由 try_transition 首次盖上）——否则这个
        # 指标在生产路径上永远是空的（BLF-1018，被场景测试抓到）。
        # 放在 seq 之前：Redis 抽风不该连锚点一起丢。
        if self._started_at is None:
            self._started_at = _as_aware(run.started_at)
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
        self._record_first_delta()
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

        Seq allocation honors the "seq from 1, strictly increasing" contract
        even when Redis hiccups between claim and allocation: the counter is
        retried, and only if it stays unreachable does the terminal frame
        fall back to the deterministic synthetic seq (never ``0``).
        """
        if not self._writer.try_mark_terminal(self._run_id, self._attempt):
            return
        seq = self._writer.next_seq(self._run_id, self._attempt)
        if seq is None:
            seq = self._synthetic_terminal_seq()
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

    def _synthetic_terminal_seq(self) -> int:
        """Deterministic seq far above any allocated one (counter unreachable)."""
        return self._attempt * 1_000_000 + 999_999

    def _record_first_delta(self) -> None:
        """Record time-to-first(content.delta) once per sink instance.

        执行器每个 run 只发一帧 content.delta（finalizing 阶段产出正文），
        所以这个值等于「距 attempt 起点的产出时延」——命名按事实叫
        first_delta_ms，不假装是逐 token 的首字。锚点由 ``open()``（重投时
        run 已开跑）或首个 ``on_status``（新建 run）补齐；两者都没有的异常
        行才跳过，不记 0 假数据。
        """
        if self._first_delta_recorded:
            return
        self._first_delta_recorded = True
        if self._started_at is None:
            return
        delta_ms = int(
            (datetime.now(timezone.utc) - self._started_at).total_seconds() * 1000
        )
        self._writer.set_metric_if_absent(
            self._run_id, METRIC_FIRST_DELTA_MS, max(0, delta_ms)
        )

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
