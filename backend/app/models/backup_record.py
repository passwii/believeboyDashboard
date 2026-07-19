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
        Index("idx_br_phase", "phase"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    backup_type: Mapped[str] = mapped_column(String(20), nullable=False)  # full/differential/wal
    status: Mapped[str] = mapped_column(String(20), nullable=False)  # pending/running/completed/failed
    # Phase 1 §3.2 P0-2 状态机: pending → pgbackrest_running → completed / failed
    phase: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")
    # Phase 1 §3.4 P0-4: manual / auto, 便于审计自动 vs 手动触发
    triggered_by: Mapped[str] = mapped_column(String(20), nullable=False, default="manual")
    # Phase 1 §3.2 P0-2: worker 重投次数 (幂等护栏辅助)
    retry_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # Phase 1 §3.3: pgbackrest set label (如 20260717-030000F), 供 restore 拼命令
    backup_set_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
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