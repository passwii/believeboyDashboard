"""External API audit-log retention sweep (BEL-377).

Daily range-delete of ``external_api_audit_log`` rows older than
``external_api_audit_retention_days`` (default 90). Keeps the high-volume
external audit table bounded.

队列：default（短任务，每日一次）。
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from celery import shared_task
from sqlalchemy import delete

logger = logging.getLogger(__name__)


@shared_task(name="external_audit_cleanup", acks_late=False)
def external_audit_cleanup() -> str:
    """Delete external audit rows past retention. Idempotent — acks_late=False."""
    from app.core.config import get_settings
    from app.db.session import SessionLocal
    from app.models.external_api_audit_log import ExternalApiAuditLog

    settings = get_settings()
    days = settings.external_api_audit_retention_days
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)

    db = SessionLocal()
    try:
        result = db.execute(
            delete(ExternalApiAuditLog).where(ExternalApiAuditLog.created_at < cutoff)
        )
        db.commit()
        deleted = result.rowcount or 0
    finally:
        db.close()

    logger.info(
        "external_audit_cleanup 完成（保留 %d 天，cutoff=%s）：删除 %d 行",
        days,
        cutoff.isoformat(),
        deleted,
    )
    return f"deleted={deleted} retention_days={days}"
