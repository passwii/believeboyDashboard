"""SHA-256 based duplicate detection for report uploads.

Detects whether a file (identified by its SHA-256 hash) has already been
ingested into the system. Unlike hard deduplication, this module only
detects and reports duplicates — it does NOT block uploads. This allows
users to intentionally re-upload the same file to different projects or
periods while being aware of existing copies.
"""
from __future__ import annotations

from dataclasses import dataclass
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.utils.models import AnalysisSourceFile


@dataclass
class DuplicateInfo:
    """Information about an existing file with the same SHA-256 hash."""
    source_id: int
    project_id: int
    report_type: str
    country: str
    period_start_date: str | None
    period_end_date: str | None
    original_filename: str | None
    uploaded_at: str | None


def find_sha256_duplicates(db: Session, file_sha256: str) -> list[DuplicateInfo]:
    """Find all existing records with the same SHA-256 hash.

    Args:
        db: Active database session.
        file_sha256: SHA-256 hex digest of the file (64 characters).

    Returns:
        List of DuplicateInfo records for existing files with the same hash.
        Empty list if no duplicates found.
    """
    rows = db.execute(
        select(AnalysisSourceFile).where(
            AnalysisSourceFile.file_sha256 == file_sha256
        )
    ).scalars().all()

    return [
        DuplicateInfo(
            source_id=row.id,
            project_id=row.project_id,
            report_type=row.report_type,
            country=row.country,
            period_start_date=row.period_start_date.isoformat() if row.period_start_date else None,
            period_end_date=row.period_end_date.isoformat() if row.period_end_date else None,
            original_filename=row.original_filename,
            uploaded_at=row.created_at.isoformat() if row.created_at else None,
        )
        for row in rows
    ]
