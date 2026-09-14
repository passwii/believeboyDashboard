"""Celery task that generates the AI summary for a sent delivery_log.

BLF-1014：AI 摘要迁移到 ``schedule_report_summary.v1`` Insight run。本任务
不再直接调 LLM——它是 adapter 的传输层：

1. 在 ``ai_summary`` 信号量内提交（或 replay）Insight run
   （幂等键 ``delivery:{log_id}``，同一 delivery 只扣一次费）。
2. **提交即返回**：run 仍在跑就立刻结束，终态回写由 insights worker 的
   终态钩子完成（``insights.run._sync_business_writeback``）。绝不在本任务
   里等待——``believeboy-celery`` 是 ``--concurrency=1`` 且同吃 insights /
   ai_summary 队列，等待会占住被等待任务唯一可用的槽位（生产实证：run
   只能等等待方 soft_time_limit 自杀后才被接收）。
   只有 replay 到**已终态**的 run（用户再次点击）才当场同步一次。
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


def _sync_if_terminal(run_id: str) -> dict[str, Any] | None:
    """run 已终态则当场回写 delivery_log；仍在跑返回 None。

    只服务「replay 到已终态 run」这一种情况（用户再次点击、任务重投）：
    常规交付由 insights worker 的终态钩子完成，本任务绝不等待。
    """
    from app.db.session import SessionLocal
    from app.services.insight.lifecycle import TERMINAL_STATUSES
    from app.services.insight.runs import RunNotFound, get_run
    from app.services.scheduled_report.insight_adapter.sync import (
        sync_delivery_log_for_run,
    )

    db = SessionLocal()
    try:
        try:
            run = get_run(db, run_id)
        except RunNotFound:
            return None
        if run.status not in TERMINAL_STATUSES:
            return None
        sync_delivery_log_for_run(db, run)
        return {"status": "terminal", "run_id": run_id, "run_status": run.status}
    finally:
        db.close()


@shared_task(
    name=TASK_NAME,
    bind=True,
    acks_late=True,
    max_retries=2,
    soft_time_limit=120,  # 提交（含报告载荷构建）预算；不再等待 LLM
    time_limit=240,
)
def generate_delivery_summary(
    self,
    log_id: int,
    ledger_key: str | None = None,
    override_ai_model: str | None = None,
) -> dict[str, Any]:
    """Submit the AI summary Insight run for a sent delivery_log row (BLF-1014).

    This task is the adapter's transport layer: it submits (or replays) the
    ``schedule_report_summary.v1`` run and returns immediately. The LLM call
    lives in the Insight executor (``execute_insight_run``) and the outcome is
    written back to the delivery_log's ``ai_summary_*`` fields by that worker's
    terminal hook (``insights.run._sync_business_writeback``).

    Why not wait here: ``believeboy-celery`` runs ``--concurrency=1`` and
    consumes both the ``insights`` and ``ai_summary`` queues, so polling for a
    run from inside a task occupies the only slot and the awaited
    ``execute_insight_run`` can never start (production-proven: the run was
    only picked up after the waiter hit its soft time limit).

    Retries/redeliveries are safe: the run row's idempotency key
    (``delivery:{log_id}``) makes a duplicate submit a replay, and a terminal
    run is never re-executed.
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

            run_id = outcome["run_id"]
            # replay 到已终态的 run（用户再次点击）→ 当场回写；
            # 仍在跑的 run 则立刻返回，交付交给 insights worker 的终态钩子。
            terminal = _sync_if_terminal(run_id)
            if terminal is not None:
                return {"log_id": log_id, **terminal}
            return {"status": "submitted", "log_id": log_id, "run_id": run_id}
    except Exception as exc:
        logger.exception(
            "generate_delivery_summary: log_id=%s failed unexpectedly",
            log_id,
        )
        _mark_ai_summary_failed(log_id, str(exc))
        # Re-raise so Celery records a retryable failure (until max_retries).
        raise
