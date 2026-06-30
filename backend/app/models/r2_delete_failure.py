"""R2 Delete Failure tracking.

Records every R2 deletion attempt that did not successfully remove the object,
so a cron can retry later (P3.2 retry_r2_dead_letters.py).

Lifecycle:
  - On delete attempt (P1 endpoint code + P2 ORM hook) -> record row (resolved_at=NULL)
  - Retry script -> if success, set resolved_at; if failure, increment retry_count
  - retry_count >= MAX_RETRIES -> operator alerted (Sentry/email), manual intervention

Columns:
  - r2_key: the R2 object key we tried to delete.
  - error_class / error_message: classification for diagnosis.
  - source: who logged it (orm_hook / endpoint subscription_delete / monthly_delete / etc.)
  - context_json: arbitrary context for debugging (row id, model, endpoint).
  - retry_count: how many times we've retried.
  - last_retry_at: when the most recent retry happened.
  - resolved_at: when a retry succeeded (NULL = still broken).
  - created_via_hook: True if logged by ORM after_commit hook (P2); False if logged
    by an explicit endpoint call (P1 endpoint patches).
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class R2DeleteFailure(Base):
    __tablename__ = 'r2_delete_failures'

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    r2_key: Mapped[str] = mapped_column(Text, nullable=False)
    error_class: Mapped[str | None] = mapped_column(String(128), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    source: Mapped[str] = mapped_column(String(64), nullable=False)
    context_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    retry_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default='0')
    last_retry_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_via_hook: Mapped[bool] = mapped_column(
        nullable=False, default=False, server_default='false'
    )
    attempted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __repr__ = lambda self: (
        f'<R2DeleteFailure id={self.id} key={self.r2_key!r} '
        f'source={self.source} retries={self.retry_count}'
        f'{" resolved" if self.resolved_at else " OPEN"}>'
    )
