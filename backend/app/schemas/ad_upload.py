from typing import Literal

from pydantic import BaseModel, Field


AdUploadType = Literal[
    'ad_time_trend_report',
    'ad_campaign_report',
    'ad_budget_report',
    'ad_placement_report',
    'ad_invalid_traffic_report',
    'ad_search_term_report',
    'ad_target_report',
    'ad_search_term_share_report',
    'ad_promoted_product_report',
    'ad_purchased_product_report',
    'unknown',
]
AdUploadRecognitionStatus = Literal['recognized', 'unsupported', 'error']
AdUploadIngestionStatus = Literal['pending', 'saved', 'failed']


class AdUploadProjectMatchSummary(BaseModel):
    status: Literal['unmatched', 'matched', 'conflict', 'manual']
    project_name: str | None = None
    candidate_projects: list[str] = Field(default_factory=list)
    matched_by: str | None = None
    matched_values: list[str] = Field(default_factory=list)
    message: str | None = None


class AdUploadRecognitionResponse(BaseModel):
    temp_file_id: str
    original_filename: str
    extension: str
    report_type: AdUploadType
    report_label: str
    matched_columns: list[str]
    reason: str
    status: AdUploadRecognitionStatus
    country: str = 'US'
    detected_report_date: str | None = None
    detected_start_date: str | None = None
    detected_end_date: str | None = None
    project_match: AdUploadProjectMatchSummary
    row_count_preview: int | None = None
    warnings: list[str] = Field(default_factory=list)


class AdUploadCommitRequest(BaseModel):
    temp_file_id: str
    report_type: AdUploadType
    original_filename: str | None = None
    project_name: str | None = None
    country: str = 'US'
    report_date: str | None = None
    report_start_date: str | None = None
    report_end_date: str | None = None


class AdUploadCommitResponse(BaseModel):
    id: int
    report_type: AdUploadType
    report_label: str
    ingestion_status: AdUploadIngestionStatus
    project_name: str
    country: str
    report_date: str | None = None
    report_start_date: str
    report_end_date: str
    file_id: str
    file_path: str
    version: int
    is_current: bool
    message: str


class AdUploadStatusItem(BaseModel):
    id: int
    project_name: str
    report_type: AdUploadType
    report_label: str
    country: str
    report_date: str | None = None
    report_start_date: str
    report_end_date: str
    version: int
    is_current: bool
    recognition_status: AdUploadRecognitionStatus
    ingestion_status: AdUploadIngestionStatus
    original_filename: str | None = None
    row_count_preview: int | None = None
    updated_at: str | None = None
    warnings: list[str] = Field(default_factory=list)


class AdUploadStatusResponse(BaseModel):
    country: str = 'US'
    items: list[AdUploadStatusItem]
