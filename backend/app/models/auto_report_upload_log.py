"""AutoReportUpload runtime log — one row per processed file.

Each row corresponds to one pipe-delimited result line printed to the console
during a file-processing cycle.  Written by the ``RunLogger.result()`` method
in the autoReportUpload service.

This table has **no foreign keys** so that logging never blocks on FK
constraint failures when the main service tables are unavailable.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    DateTime,
    Float,
    Index,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class AutoReportUploadLog(Base):
    """One processing result row from the autoReportUpload service."""

    __tablename__ = "auto_report_upload_logs"
    __table_args__ = (
        Index("idx_aru_logs_created_at", "created_at"),
        Index("idx_aru_logs_run_id", "run_id"),
        Index("idx_aru_logs_status", "status"),
        Index("idx_aru_logs_project_status", "project_name", "status"),
    )

    id: Mapped[int] = mapped_column(
        Integer,
        primary_key=True,
        autoincrement=True,
    )

    # ── Run identifier ────────────────────────────────────────────────────
    run_id: Mapped[str] = mapped_column(
        String(32), nullable=False, index=False,
        comment="run batch id, e.g. auto-20260630_153000",
    )

    # ── Timestamp ─────────────────────────────────────────────────────────
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
        comment="when this log row was written",
    )

    # ── Console-visible columns (rendered directly in the frontend table) ──
    status: Mapped[str] = mapped_column(
        String(10), nullable=False, index=False,
        comment="success | skipped | failed",
    )
    country: Mapped[str] = mapped_column(
        String(10), nullable=False,
    )
    project_name: Mapped[str] = mapped_column(
        String(100), nullable=False, index=False,
    )
    report_type_label: Mapped[str] = mapped_column(
        String(100), nullable=False,
        comment="Chinese label e.g. 搜索词展示量份额",
    )
    report_date_display: Mapped[str | None] = mapped_column(
        String(20), nullable=True,
        comment="Compressed date display e.g. 06-25 / 06-25~06-28",
    )

    # ── Hidden / detail columns ───────────────────────────────────────────
    report_type: Mapped[str | None] = mapped_column(
        String(64), nullable=True,
        comment="English report_type key for filtering, e.g. ad_search_term_report",
    )
    original_filename: Mapped[str | None] = mapped_column(
        String(256), nullable=True,
    )
    source_id: Mapped[int | None] = mapped_column(
        Integer, nullable=True,
        comment="Primary key of the ingested row (analysis_source_files / ad_upload_files)",
    )
    source_table: Mapped[str | None] = mapped_column(
        String(4), nullable=True,
        comment="A = analysis_source_files, C = ad_upload_files",
    )
    row_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0,
        comment="Number of rows persisted (meaningful when status=success)",
    )
    detected_start_date: Mapped[str | None] = mapped_column(
        String(20), nullable=True,
        comment="Full start date YYYY-MM-DD",
    )
    detected_end_date: Mapped[str | None] = mapped_column(
        String(20), nullable=True,
        comment="Full end date YYYY-MM-DD",
    )
    duration_seconds: Mapped[float | None] = mapped_column(
        Float, nullable=True,
        comment="Total processing wall-clock time in seconds",
    )
    error_message: Mapped[str | None] = mapped_column(
        Text, nullable=True,
        comment="Full error trace or skip reason (untruncated)",
    )
    note: Mapped[str | None] = mapped_column(
        String(500), nullable=True,
        comment="Free-form note for things that can't be structured",
    )
