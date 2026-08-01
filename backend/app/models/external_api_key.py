"""External API key (BEL-377).

Application-layer credentials for the ``/api/v1/external/*`` namespace.
Only the SHA-256 hash of a key is stored; the plaintext is shown exactly
once at creation time (``POST /api/v1/internal/api-keys``).

House style follows ``alert_rule.py``: ``Integer`` primary key, ``Mapped``
annotations, timezone-aware timestamps with server defaults.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Index, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class ExternalApiKey(Base):
    __tablename__ = "external_api_keys"
    __table_args__ = (
        Index("idx_eak_key_hash", "key_hash", unique=True),
        Index("idx_eak_revoked_expires", "is_revoked", "expires_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # SHA-256 hex digest (64 chars) of the plaintext key. Unique — this is
    # what the auth path looks up.
    key_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    # Short non-secret prefix (e.g. ``bbx_ab12cd34``) for display in the
    # admin list so operators can tell keys apart without the secret.
    key_prefix: Mapped[str] = mapped_column(String(24), nullable=False)
    label: Mapped[str] = mapped_column(String(128), nullable=False)
    # Reserved for P2 per-key scope restrictions; initially every key has
    # full read access ("read").
    scope: Mapped[str] = mapped_column(String(64), nullable=False, default="read")
    is_revoked: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_by: Mapped[str] = mapped_column(String(128), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    last_used_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
