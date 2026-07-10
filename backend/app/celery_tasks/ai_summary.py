"""Celery task that generates the AI summary for a sent delivery_log.

Tracks `scheduled_report_delivery_logs.ai_summary_status` across the
`generating` → `done` / `failed` lifecycle, and synchronises a Redis-backed
semaphore so the LLM calls don't exceed `MAX_CONCURRENT_AI_SUMMARY`
(方案 §4.6, independent from the `insights` semaphore).
"""

from __future__ import annotations

import logging

from celery import shared_task

from app.core.config import get_settings
from app.services.insight_concurrency import acquire_remote_semaphore

logger = logging.getLogger(__name__)


TASK_NAME = "generate_delivery_summary"


def _mark_ai_summary_failed(log_id: int, error_message: str) -> None:
    """Update the log row to ai_summary_status=failed on a fatal early exit.

    Used when:
    - the Redis semaphore could not be acquired within `timeout` seconds.
    - any unexpected exception escapes the LLM call.

    Late-failure (semaphore acquired → LLM raises) is handled inside
    `generate_ai_summary_for_delivery_log` itself (it calls
    `update_delivery_log_ai_summary_status(..., FAILED, ...)` on the same
    `db`). This helper only covers the *task-body-level* failure paths so
    a permanent hang on the broker doesn't leave the row stuck at
    `PENDING`.
    """
    from app.db.session import SessionLocal
    from app.models.scheduled_report import (
        AiSummaryStatus,
        ScheduledReportDeliveryLog,
    )
    from app.services.scheduled_report.subscription_service import (
        update_delivery_log_ai_summary_status,
    )

    db = SessionLocal()
    try:
        log = db.get(ScheduledReportDeliveryLog, log_id)
        if log is None:
            logger.warning("_mark_ai_summary_failed: log_id=%s not found", log_id)
            return
        update_delivery_log_ai_summary_status(
            db,
            log_id,
            AiSummaryStatus.FAILED.value,
            error_message=error_message,
        )
    except Exception:  # noqa: BLE001
        db.rollback()
        logger.exception("_mark_ai_summary_failed: log_id=%s rollback", log_id)
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
) -> dict[str, Any]:  # noqa: F821
    """Generate an AI summary for a sent delivery_log row.

    Routes through `app.celery_tasks.scheduled_report.ai_summary` indirectly
    via `_mark_ai_summary_failed`. The LLM call itself lives in
    `app.services.scheduled_report.ledger_service.generate_ai_summary_for_delivery_log`
    — extracted verbatim and re-used unchanged. The Celery layer adds:

    1. Independent Redis semaphore under the `"ai_summary"` key, capped by
       `Settings.max_concurrent_ai_summary` (independent from `insights`).
    2. Soft + hard time limits.
    3. Standard `acks_late` retry, recovering from worker kills.
    """
    from typing import Any  # local

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
                    log_id,
                    f"ai_summary semaphore timeout (>{300}s)",
                )
                return {"status": "semaphore_timeout", "log_id": log_id}

            from app.services.scheduled_report.ledger_service import (
                generate_ai_summary_for_delivery_log,
            )

            generate_ai_summary_for_delivery_log(
                log_id=log_id,
                ledger_key=ledger_key,
                override_ai_model=override_ai_model,
            )
            return {"status": "completed", "log_id": log_id}
    except Exception as exc:  # noqa: BLE001
        logger.exception(
            "generate_delivery_summary: log_id=%s failed unexpectedly",
            log_id,
        )
        _mark_ai_summary_failed(log_id, str(exc))
        # Re-raise so Celery records a retryable failure (until max_retries).
        raise
