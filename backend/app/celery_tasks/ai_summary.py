"""Celery task that generates the AI summary for a sent delivery_log.

BLF-1014：AI 摘要迁移到 ``schedule_report_summary.v1`` Insight run。本任务
不再直接调 LLM——它是 adapter 的传输层：

1. 在 ``ai_summary`` 信号量内提交（或 replay）Insight run
   （幂等键 ``delivery:{log_id}``，同一 delivery 只扣一次费）。
2. 阻塞等待 run 到终态（soft/hard time limit 兜底），把终态同步回
   delivery_log 的 ``ai_summary_*`` 字段（completed→done / failed→failed /
   cancelled→pending）。
3. 提交失败（订阅缺失、scope 不可用等）→ delivery_log 直接标 failed，
   不影响邮件主流程（邮件在 dispatch_one 里早已发送完毕）。

信号量（``ai_summary`` bucket，``Settings.max_concurrent_ai_summary``）
继续约束本任务并发，与旧实现一致（方案 §4.6）。
"""

from __future__ import annotations

import logging
from typing import Any

from celery import shared_task

from app.core.config import get_settings
from app.services.insight_concurrency import acquire_remote_semaphore

logger = logging.getLogger(__name__)


TASK_NAME = "generate_delivery_summary"

#: 等待 Insight run 终态的轮询参数：200ms 间隔；由任务的 soft_time_limit
#: （120s）封顶——到点后任务重试（同 attempt resume）或耗尽后 park failed。
_WAIT_INTERVAL_SEC = 0.2


def _mark_ai_summary_failed(log_id: int, error_message: str) -> None:
    """Update the log row to ai_summary_status=failed on a fatal early exit.

    Late-failure (semaphore acquired → LLM raises) is handled inside
    `generate_ai_summary_for_delivery_log` itself (it calls
    `update_delivery_log_ai_summary_status(..., FAILED, ...)` on the same
    `db`). This helper only covers the *task-body-level* failure paths so
    a permanent hang on the broker doesn't leave the row stuck at
    `generating` forever.
    """
    from app.db.session import SessionLocal
    from app.models.scheduled_report import ScheduledReportDeliveryLog
    from app.services.scheduled_report.subscription_service import (
        update_delivery_log_ai_summary_status,
    )

    db = SessionLocal()
    try:
        log = db.get(ScheduledReportDeliveryLog, log_id)
        if log is None:
            return
        update_delivery_log_ai_summary_status(
            db,
            log_id,
            "failed",
            error_message=error_message,
        )
    except Exception:
        db.rollback()
        logger.exception("_mark_ai_summary_failed: log_id=%s rollback", log_id)
    finally:
        db.close()


def _record_summary_fallback(reason: str) -> None:
    """登记一次「预约报表 AI 摘要未走 canonical 链路」的降级事件（BLF-1018）。

    这是观测期降级比例（fallback ratio）的真实来源：semaphore 超时或提交
    失败意味着本次摘要没有落到 Insight run 上。只记原因码与 log_id，
    报告正文/提示词一律不入库。
    """
    from app.services.insight.observation import (
        FALLBACK_CAPABILITY_AI_SUMMARY,
        record_fallback,
    )

    record_fallback(
        capability=FALLBACK_CAPABILITY_AI_SUMMARY,
        reason=reason,
        role_id="schedule_report_summary",
    )


def _wait_for_terminal_and_sync(run_id: str) -> dict[str, Any]:
    """轮询 run 行直到终态并同步 delivery_log（每次 tick 都尝试同步）。"""
    import time

    from sqlalchemy import select

    from app.db.session import SessionLocal
    from app.models.scheduled_report import ScheduledReportDeliveryLog
    from app.services.insight.runs import RunNotFound, get_run
    from app.services.scheduled_report.insight_adapter.sync import (
        sync_delivery_log_from_run,
    )

    db = SessionLocal()
    try:
        while True:
            try:
                run = get_run(db, run_id)
            except RunNotFound:
                return {"status": "run_not_found", "run_id": run_id}
            log = db.execute(
                select(ScheduledReportDeliveryLog).where(
                    ScheduledReportDeliveryLog.insight_run_id == run_id
                )
            ).scalars().first()
            if log is None:
                # delivery_log 已被删除：run 继续与否都无落点，退出等待。
                return {"status": "terminal_no_log", "run_id": run_id}
            # sync 返回 True 即终态已写入（completed/failed/cancelled 三态
            # 都算终态：cancelled 回写 pending 后同样结束等待）。
            if sync_delivery_log_from_run(db, log, run):
                return {
                    "status": "terminal",
                    "run_id": run_id,
                    "run_status": run.status,
                }
            time.sleep(_WAIT_INTERVAL_SEC)
    finally:
        db.close()


@shared_task(
    name=TASK_NAME,
    bind=True,
    acks_late=True,
    max_retries=2,
    soft_time_limit=120,  # §4.8 LLM 调用常态 < 60s
    time_limit=240,  # hard kill — anything past 4min should be retried, not blocking
)
def generate_delivery_summary(
    self,
    log_id: int,
    ledger_key: str | None = None,
    override_ai_model: str | None = None,
) -> dict[str, Any]:
    """Generate an AI summary for a sent delivery_log row (BLF-1014).

    Submits (or replays) the ``schedule_report_summary.v1`` Insight run for
    this delivery, then observes it to a terminal state and writes the
    outcome back to the delivery_log's ``ai_summary_*`` fields. The LLM call
    itself lives in the Insight executor (``execute_insight_run``), driven by
    the server-side provider contract — never in this task body.

    Retries/redeliveries are safe: the run row's idempotency key
    (``delivery:{log_id}``) makes a duplicate submit a replay, and a
    terminal run is never re-executed.
    """
    from app.services.scheduled_report.ledger_service import (
        generate_ai_summary_for_delivery_log,
    )

    settings = get_settings()

    try:
        with acquire_remote_semaphore(
            "ai_summary",
            timeout=300,
            max_concurrent=settings.max_concurrent_ai_summary,
        ) as acquired:
            if not acquired:
                logger.warning(
                    "generate_delivery_summary: semaphore timeout log_id=%s",
                    log_id,
                )
                _mark_ai_summary_failed(
                    log_id, f"ai_summary semaphore timeout (>{300}s)"
                )
                _record_summary_fallback("semaphore_timeout")
                return {"status": "semaphore_timeout", "log_id": log_id}

            outcome = generate_ai_summary_for_delivery_log(
                log_id=log_id,
                ledger_key=ledger_key,
                override_ai_model=override_ai_model,
            )
            if outcome.get("status") != "submitted" or not outcome.get("run_id"):
                _mark_ai_summary_failed(
                    log_id, outcome.get("message") or "AI 摘要提交失败"
                )
                _record_summary_fallback("submit_failed")
                return {"status": "submit_failed", "log_id": log_id}

            synced = _wait_for_terminal_and_sync(outcome["run_id"])
            return {"status": synced.get("status", "terminal"), "log_id": log_id, **{
                k: v for k, v in synced.items() if k != "status"
            }}
    except Exception as exc:
        logger.exception(
            "generate_delivery_summary: log_id=%s failed unexpectedly",
            log_id,
        )
        _mark_ai_summary_failed(log_id, str(exc))
        # Re-raise so Celery records a retryable failure (until max_retries).
        raise
