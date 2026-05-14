"""Shared persistence helpers for analysis_source_files and report_upload_logs.

These functions operate on the shared ``AnalysisSourceFile`` model
(``app.shared.models``) and the backend's ``ReportUploadLog`` model.  Both
the backend service and autoReportUpload import from here so versioning,
current-pointer management, and upload-log writing stay in sync.
"""
from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Any

from sqlalchemy import func, select, update as sa_update
from sqlalchemy.orm import Session

from app.utils.models import AnalysisSourceFile

from app.utils.constants import PERIODIC_REPORT_TYPES


def next_version(
    db: Session,
    *,
    project_id: int,
    report_type: str,
    country: str,
    period_start_date: date | None,
    period_end_date: date | None,
) -> int:
    """Return the next version number for a given (project, type, country, period)."""
    stmt = select(func.max(AnalysisSourceFile.version)).where(
        AnalysisSourceFile.project_id == project_id,
        AnalysisSourceFile.report_type == report_type,
        AnalysisSourceFile.country == country,
    )
    if report_type in PERIODIC_REPORT_TYPES:
        stmt = stmt.where(
            AnalysisSourceFile.period_start_date == period_start_date,
            AnalysisSourceFile.period_end_date == period_end_date,
        )
    value = db.execute(stmt).scalar_one_or_none()
    return int(value or 0) + 1


def replace_current_pointer(db: Session, source: AnalysisSourceFile) -> None:
    """Mark all older versions of the same report as superseded.

    For periodic reports the match is scoped to (project, type, country, period).
    For inventory reports the match is scoped to (project, type, country).
    """
    conditions = [
        AnalysisSourceFile.project_id == source.project_id,
        AnalysisSourceFile.report_type == source.report_type,
        AnalysisSourceFile.country == source.country,
        AnalysisSourceFile.id != source.id,
        AnalysisSourceFile.is_current.is_(True),
    ]
    if source.report_type in PERIODIC_REPORT_TYPES:
        conditions.extend([
            AnalysisSourceFile.period_start_date == source.period_start_date,
            AnalysisSourceFile.period_end_date == source.period_end_date,
        ])
    db.execute(
        sa_update(AnalysisSourceFile)
        .where(*conditions)
        .values(is_current=False, superseded_at=datetime.now(UTC))
    )


def write_report_upload_log(
    db: Session,
    project_id: int,
    country: str,
    report_type: str,
    *,
    upload_date: date | None = None,
    source_file_id: int | None = None,
    has_real_data: bool = True,
    row_count: int = 0,
    original_filename: str | None = None,
) -> None:
    """Write a single row to ``report_upload_logs``.

    Imported lazily to avoid circular imports — ``ReportUploadLog`` lives in
    the backend's ORM layer, not the shared models.
    """
    from app.models.report_upload_log import ReportUploadLog

    log = ReportUploadLog(
        project_id=project_id,
        report_type=report_type,
        country=country,
        upload_date=upload_date or date.today(),
        has_real_data=has_real_data,
        row_count=row_count,
        source_file_id=source_file_id,
        original_filename=original_filename,
    )
    db.add(log)
