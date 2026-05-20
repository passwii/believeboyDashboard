from __future__ import annotations

from datetime import date, datetime
from typing import Any

from pydantic import BaseModel


class AnalysisSourceFileItem(BaseModel):
    id: int
    project_id: int
    report_type: str
    report_date: date | None
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


class PeriodCompleteness(BaseModel):
    total_days: int
    available_business_days: int
    available_ad_days: int
    business_missing_dates: list[str] = []
    ad_missing_dates: list[str] = []
    payment_covered: bool
    payment_type: str = 'none'
    payment_missing: bool = True
    payment_missing_dates: list[str] = []
    payment_objective_empty: bool = False
    payment_objective_empty_dates: list[str] = []


class ProductAnalysisWeeklyRecomputePeriodItem(BaseModel):
    pt1_id: int
    version: int
    report_start_date: date
    report_end_date: date
    row_count: int
    business_report_source_id: int
    ad_report_source_id: int
    payment_report_source_id: int | None = None
    is_partial: bool = False
    completeness: PeriodCompleteness | None = None


class ProductAnalysisWeeklyRecomputeResponse(BaseModel):
    project_id: int
    project_name: str
    country: str
    recomputed: int
    skipped: int
    periods: list[ProductAnalysisWeeklyRecomputePeriodItem]


# --- 产品核算（从数据库读取，无文件上传） ---

from datetime import date as _date


class ProductCalculationCheckRequest(BaseModel):
    project_id: int
    country: str = "US"
    start_date: _date
    end_date: _date


class ProductCalculationRunRequest(BaseModel):
    project_id: int
    country: str = "US"
    start_date: _date
    end_date: _date
    current_only: bool = True


class PaymentPeriodOverlapItem(BaseModel):
    period_start_date: _date
    period_end_date: _date
    source_id: int


class PeriodCoverageInfoItem(BaseModel):
    period_start_date: str
    period_end_date: str
    source_id: int
    covered_dates: list[str]


class WeeklyAvailabilityItem(BaseModel):
    iso_year: int
    iso_week: int
    week_start_date: str
    week_end_date: str
    total_days: int
    business_report_available_days: int
    ad_report_available_days: int
    business_periodic_covered: bool = False
    ad_periodic_covered: bool = False
    payment_covered: bool
    can_calculate: bool
    is_partial: bool
    business_missing_dates: list[str] = []
    ad_missing_dates: list[str] = []
    payment_objective_empty_dates: list[str] = []


class ProductCalculationCheckResponse(BaseModel):
    business_report_missing: list[str]
    ad_report_missing: list[str]
    inventory_missing: list[str]
    business_period_info: list[PeriodCoverageInfoItem] = []
    ad_period_info: list[PeriodCoverageInfoItem] = []
    business_periodic_only_missing: list[str] = []
    ad_periodic_only_missing: list[str] = []
    payment_periods_overlapping: list[PaymentPeriodOverlapItem]
    payment_full_period_covered: bool
    payment_daily_covered_dates: list[str]
    payment_objective_empty_dates: list[str] = []
    has_minimum_data: bool
    weekly_availability: list[WeeklyAvailabilityItem] = []


class CalculationPeriodItem(BaseModel):
    report_start_date: str
    report_end_date: str
    summary: dict[str, Any]
    details: list[dict[str, Any]]
    is_partial: bool = False
    completeness: PeriodCompleteness | None = None
    persisted: bool = False
    pt1_id: int | None = None
    version: int | None = None


class ProductCalculationRunResponse(BaseModel):
    project_id: int
    project_name: str
    country: str
    total_periods: int
    periods: list[CalculationPeriodItem]
