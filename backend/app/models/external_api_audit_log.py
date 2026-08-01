"""External API audit log (BEL-377).

One row per ``/api/v1/external/*`` request: method, path, resolved API key
id (null for anonymous/master-key/skip traffic), status code, latency and
client IP. Retention is bounded by a Celery cleanup task
(``external_api_audit_retention_days``, default 90).

A dedicated table (rather than reusing ``operation_audit_logs``) keeps the
high-volume external traffic isolated and makes the retention sweep a cheap
range delete on ``created_at``.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Index, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class ExternalApiAuditLog(Base):
    __tablename__ = "external_api_audit_log"
    __table_args__ = (
        Index("idx_eaal_created_at", "created_at"),
        Index("idx_eaal_api_key_id", "api_key_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    method: Mapped[str] = mapped_column(String(16), nullable=False)
    path: Mapped[str] = mapped_column(String(255), nullable=False)
    # ``external_api_keys.id`` when the request authenticated with a DB key;
    # null for master-key, ``?skip_auth=true``, or unauthenticated traffic.
    # Deliberately not a FK: audit rows must survive key deletion.
    api_key_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status_code: Mapped[int] = mapped_column(Integer, nullable=False)
    latency_ms: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    ip_address: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
