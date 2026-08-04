"""Agent API access audit log（BEL-377 external_api_audit_log 改名而来）。

过渡期每个 ``/api/v1/external/*`` 与 ``/api/v1/agent/*`` 请求一行：
method、path、凭据 id（匿名/master/skip 流量为 null）、status、latency、IP。
保留期由 Celery 清理任务约束（``agent_api_audit_retention_days``，默认 90）。

高流量访问日志单独成表（不复用 ``operation_audit_logs``），保留期清理
只是 ``created_at`` 上的廉价 range delete。
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Index, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class AgentApiAuditLog(Base):
    __tablename__ = "agent_api_audit_log"
    __table_args__ = (
        Index("idx_aaal_created_at", "created_at"),
        Index("idx_aaal_api_key_id", "api_key_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    method: Mapped[str] = mapped_column(String(16), nullable=False)
    path: Mapped[str] = mapped_column(String(255), nullable=False)
    # ``agent_api_keys.id`` when the request authenticated with a DB key;
    # null for master-key, ``?skip_auth=true``, or unauthenticated traffic.
    # Deliberately not a FK: audit rows must survive key deletion.
    api_key_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status_code: Mapped[int] = mapped_column(Integer, nullable=False)
    latency_ms: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    ip_address: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
