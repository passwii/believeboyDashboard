"""Backup Record Model - tracks PostgreSQL backup history."""

from __future__ import annotations

from datetime import datetime
from enum import Enum

from sqlalchemy import BigInteger, DateTime, Index, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class BackupStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


class BackupType(str, Enum):
    FULL = "full"
    DIFFERENTIAL = "differential"
    WAL_ARCHIVE = "wal_archive"


class BackupRecord(Base):
    __tablename__ = "backup_records"
    __table_args__ = (
        Index("idx_br_status", "status"),
        Index("idx_br_created", "created_at"),
        Index("idx_br_type", "backup_type"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    backup_type: Mapped[str] = mapped_column(String(20), nullable=False)  # full/differential/wal
    status: Mapped[str] = mapped_column(String(20), nullable=False)  # pending/running/completed/failed
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    size_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    duration_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    backup_info: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON backup info from pgbackrest
    created_by: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )