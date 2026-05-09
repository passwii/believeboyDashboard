from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class ReconciliationRecordItem(BaseModel):
    field_name: str
    db_value: float | None
    pdf_value: float | None
    match: bool
    difference: float | None = None
    difference_percent: float | None = None


class ReconciliationRecordSummary(BaseModel):
    db_total_income: float | None
    db_total_expense: float | None
    db_net_amount: float | None
    pdf_total_income: float | None
    pdf_total_expense: float | None
    pdf_net_amount: float | None


class ReconciliationRecordResponse(BaseModel):
    id: int
    report_id: int
    project_name: str
    country: str
    report_month: str
    operator: str
    mode: str
    match_rate: float
    matched_items: int
    mismatched_items: int
    missing_items: int
    total_items: int
    summary: ReconciliationRecordSummary
    detail_json: list[ReconciliationRecordItem]
    created_at: datetime


class AvailableReportItem(BaseModel):
    report_id: int
    project_name: str
    country: str
    report_month: str
    has_summary_pdf: bool
    pdf_uploaded_at: datetime | None
    pt3_calculation_complete: bool
    pt4_calculation_complete: bool
    status: str
    pdf_file_missing: bool = False  # True if path exists but file is missing
    # Reconciliation status from history
    reconciled: bool = False
    reconcile_match_rate: float | None = None
    reconcile_record_id: int | None = None


class AvailableReportsResponse(BaseModel):
    reports: list[AvailableReportItem]
    total: int


class AutoReconcileRequest(BaseModel):
    report_id: int = Field(..., gt=0)
    tolerance: float = Field(default=0.01, ge=0)
    country: str | None = Field(default=None, description="Country code for number format (e.g., US, DE)")


class ReconciliationHistoryResponse(BaseModel):
    records: list[ReconciliationRecordResponse]
    total: int


class ReconcileResultItem(BaseModel):
    field_name: str
    excel_value: float | None = Field(default=None, alias="db_value")
    pdf_value: float | None = None
    match: bool
    difference: float | None = None
    difference_percent: float | None = None

    class Config:
        populate_by_name = True


class ReconcileResultSummary(BaseModel):
    db_total_income: float | None = None
    db_total_expense: float | None = None
    db_net_amount: float | None = None
    pdf_total_income: float | None = None
    pdf_total_expense: float | None = None
    pdf_net_amount: float | None = None


class ReconcileResultResponse(BaseModel):
    summary: ReconcileResultSummary
    total_items: int
    matched_items: int
    mismatched_items: int
    missing_items: int
    match_rate: float
    items: list[ReconcileResultItem]
    record_id: int | None = None


class PDFUploadResponse(BaseModel):
    report_id: int
    pdf_file_id: str
    pdf_file_path: str
    original_filename: str
    size: int
    message: str
