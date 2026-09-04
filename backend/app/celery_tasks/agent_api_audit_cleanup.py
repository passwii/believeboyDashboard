"""Agent API audit-log retention sweep（external_audit_cleanup 改名，设计稿 §11）。

Daily range-delete of ``agent_api_audit_log`` rows older than
``agent_api_audit_retention_days`` (default 90).

队列：default（短任务，每日一次）。
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from celery import shared_task
from sqlalchemy import delete

from app.services.infra.cache_decorator import mark_committed

logger = logging.getLogger(__name__)


@shared_task(name="agent_api_audit_cleanup", acks_late=False)
def agent_api_audit_cleanup() -> str:
    """Delete agent API audit rows past retention. Idempotent — acks_late=False."""
    from app.core.config import get_settings
    from app.db.session import SessionLocal
    from app.models.agent_api_audit_log import AgentApiAuditLog

    settings = get_settings()
    days = settings.agent_api_audit_retention_days
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)

    db = SessionLocal()
    try:
        result = db.execute(
            delete(AgentApiAuditLog).where(AgentApiAuditLog.created_at < cutoff)
        )
        db.commit()
        mark_committed()  # BLF-669: commit 后必须 mark
        deleted = result.rowcount or 0
    finally:
        db.close()

    logger.info(
        "agent_api_audit_cleanup 完成（保留 %d 天，cutoff=%s）：删除 %d 行",
        days,
        cutoff.isoformat(),
        deleted,
    )
    return f"deleted={deleted} retention_days={days}"
