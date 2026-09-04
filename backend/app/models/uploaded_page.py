from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Index, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class UploadedPage(Base):
    """User-uploaded Markdown/HTML page, stored publicly in R2 and rendered at /p/{id}.

    - id is a public-facing UUID string (not enumerable).
    - owner_user_id scopes the history list endpoint to the uploader.
    - r2_key / public_url are the source of truth for content; the dashboard
      preview and the public page both load from public_url (R2 public bucket).
    - source_format is 'markdown' or 'html' (authoritative from file extension).
    """

    __tablename__ = "uploaded_pages"
    __table_args__ = (
        Index("ix_uploaded_pages_owner_created", "owner_user_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(
        String(36),
        primary_key=True,
        default=lambda: str(uuid.uuid4()),
    )
    owner_user_id: Mapped[int] = mapped_column(Integer, nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    source_format: Mapped[str] = mapped_column(String(16), nullable=False)
    original_filename: Mapped[str] = mapped_column(String(255), nullable=False)
    content_type: Mapped[str] = mapped_column(String(64), nullable=False)
    file_size: Mapped[int] = mapped_column(Integer, nullable=False)
    r2_key: Mapped[str] = mapped_column(String(512), nullable=False, unique=True)
    public_url: Mapped[str] = mapped_column(String(1024), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )