"""Agent 操作日志保留清理（BLF-460 Q5）。

Daily range-delete of ``operation_audit_logs`` rows **由 agent 产生**（
``agent_id IS NOT NULL``）且早于 ``operation_audit_retention_days``（默认 90 天）
的行——与读侧 ``agent_api_audit_cleanup`` 对齐，防止写操作明细表无限膨胀。

刻意只清 agent 行：人工 operator 的审计轨迹不受影响（既有「审计日志」页
语义不变）。

队列：default（短任务，每日一次，排 04:30 错开 04:00 的读侧清理）。
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from celery import shared_task
from sqlalchemy import delete

logger = logging.getLogger(__name__)


@shared_task(name="operation_audit_cleanup", acks_late=False)
def operation_audit_cleanup() -> str:
    """Delete agent-produced operation-audit rows past retention. Idempotent."""
    from app.core.config import get_settings
    from app.db.session import SessionLocal
    from app.models.operation_audit_log import OperationAuditLog

    settings = get_settings()
    days = settings.operation_audit_retention_days
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)

    db = SessionLocal()
    try:
        result = db.execute(
            delete(OperationAuditLog).where(
                OperationAuditLog.agent_id.is_not(None),
                OperationAuditLog.created_at < cutoff,
            )
        )
        db.commit()
        deleted = result.rowcount or 0
    finally:
        db.close()

    logger.info(
        "operation_audit_cleanup 完成（agent 行保留 %d 天，cutoff=%s）：删除 %d 行",
        days,
        cutoff.isoformat(),
        deleted,
    )
    return f"deleted={deleted} retention_days={days}"
