from pydantic import BaseModel, Field
from typing import Literal


class UploadResponse(BaseModel):
    file_id: str
    file_path: str
    filename: str
    original_filename: str
    size: int


ProjectMatchStatus = Literal['unmatched', 'matched', 'conflict', 'manual']
ReportUploadType = Literal[
    'inventory_report',
    'business_report',
    'ad_product_report',
    'ad_report',
    'ad_search_term_report',
    'sales_report',
    'payment_report',
    'return_report',
    'unknown',
]
DateInputMode = Literal['single_manual', 'single_auto', 'single_detected', 'range_manual', 'range_auto', 'multi_auto']


class ReportProjectMatchSummary(BaseModel):
    status: ProjectMatchStatus
    project_name: str | None = None
    candidate_projects: list[str] = Field(default_factory=list)
    matched_by: str | None = None
    matched_values: list[str] = Field(default_factory=list)
    message: str | None = None


class ReportRecognitionResponse(BaseModel):
    temp_file_id: str
    original_filename: str
    extension: str
    report_type: ReportUploadType
    matched_columns: list[str]
    reason: str
    status: Literal['recognized', 'unsupported', 'error']
    country: str = 'US'
    date_input_mode: DateInputMode
    detected_date: str | None = None
    detected_start_date: str | None = None
    detected_end_date: str | None = None
    project_match: ReportProjectMatchSummary
    row_count_preview: int | None = None
    warnings: list[str] = Field(default_factory=list)


class ReportCommitRequest(BaseModel):
    temp_file_id: str
    report_type: ReportUploadType
    original_filename: str | None = None
    project_name: str | None = None
    report_date: str | None = None
    report_start_date: str | None = None
    report_end_date: str | None = None
    country: str = 'US'


class ReportCommitResponse(BaseModel):
    report_type: ReportUploadType
    status: Literal['saved', 'persisted']
    project_name: str | None = None
    country: str = 'US'
    report_date: str | None = None
    report_start_date: str | None = None
    report_end_date: str | None = None
    file_id: str
    file_path: str
    persisted_source_id: int | None = None
    persisted_table: str | None = None
    message: str


class ReportStatusCell(BaseModel):
    report_type: ReportUploadType
    status: Literal['available', 'missing', 'saved_only']
    display_date: str | None = None
    report_start_date: str | None = None
    report_end_date: str | None = None
    source_table: str | None = None
    updated_at: str | None = None
    original_filename: str | None = None
    message: str | None = None


class ProjectReportStatusItem(BaseModel):
    project_id: int
    project_name: str
    statuses: dict[str, ReportStatusCell]


class ReportStatusResponse(BaseModel):
    country: str = 'US'
    items: list[ProjectReportStatusItem]
