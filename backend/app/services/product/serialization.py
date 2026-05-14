"""Product analysis serialization helpers."""

from __future__ import annotations

from app.schemas.product_analysis_source import AnalysisSourceFileItem


def to_source_item(row) -> AnalysisSourceFileItem:
    """Serialize a source database row into an AnalysisSourceFileItem."""
    return AnalysisSourceFileItem(
        id=row.id,
        project_id=row.project_id,
        report_type=row.report_type,
        report_date=row.report_date,
        period_start_date=row.period_start_date,
        period_end_date=row.period_end_date,
        snapshot_at=row.snapshot_at,
        version=row.version,
        is_current=row.is_current,
        superseded_at=row.superseded_at,
        upload_file_id=row.upload_file_id,
        upload_file_path=row.upload_file_path,
        original_filename=row.original_filename,
        stored_filename=row.stored_filename,
        logical_filename=row.logical_filename,
        storage_key=row.storage_key,
        file_size_bytes=row.file_size_bytes,
        file_sha256=row.file_sha256,
        ingestion_status=row.ingestion_status,
        ingestion_error=row.ingestion_error,
        row_count_total=row.row_count_total,
        row_count_included=row.row_count_included,
        created_by=row.created_by,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )
