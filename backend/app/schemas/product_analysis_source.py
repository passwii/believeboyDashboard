from __future__ import annotations

from datetime import date, datetime
from typing import Any

from pydantic import BaseModel


class AnalysisSourceFileItem(BaseModel):
    id: int
    project_id: int
    report_type: str
    period_start_date: date | None
    period_end_date: date | None
    snapshot_at: datetime | None
    version: int
    is_current: bool
    superseded_at: datetime | None
    upload_file_id: str
    upload_file_path: str
    original_filename: str | None
    stored_filename: str
    logical_filename: str
    storage_key: str
    file_size_bytes: int | None
    file_sha256: str | None
    ingestion_status: str
    ingestion_error: str | None
    row_count_total: int
    row_count_included: int
    created_by: str | None
    created_at: datetime | None
    updated_at: datetime | None


class AnalysisSourceRowsResponse(BaseModel):
    source: AnalysisSourceFileItem
    page: int
    page_size: int
    has_next: bool
    rows: list[dict[str, Any]]


class CurrentInventorySnapshotResponse(BaseModel):
    source: AnalysisSourceFileItem
    rows: list[dict[str, Any]]


class ProductAnalysisWeeklyRecomputePeriodItem(BaseModel):
    pt1_id: int
    version: int
    report_start_date: date
    report_end_date: date
    row_count: int
    business_report_source_id: int
    ad_report_source_id: int
    payment_report_source_id: int


class ProductAnalysisWeeklyRecomputeResponse(BaseModel):
    project_id: int
    project_name: str
    country: str
    recomputed: int
    skipped: int
    periods: list[ProductAnalysisWeeklyRecomputePeriodItem]
