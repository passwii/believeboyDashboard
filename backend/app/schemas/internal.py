"""Pydantic schemas for the autoReportUpload internal ingest endpoints.

These endpoints are called by the autoReportUpload daemon running on the
same VPS as the FastAPI service. They bypass R2 / temp-file storage entirely:
the daemon parses the file locally, sends only the parsed result + a SHA-256
fingerprint over the wire, and the backend writes the rows in a single
transaction.
"""
from __future__ import annotations

from datetime import date as _date
from typing import Literal

from pydantic import BaseModel, Field

A_TABLE_REPORT_TYPES = (
    "sales_report",
    "business_report",
    "payment_report",
    "inventory_report",
    "return_report",
)
C_TABLE_REPORT_TYPES = (
    "ad_budget_report",
    "ad_campaign_report",
    "ad_placement_report",
    "ad_invalid_traffic_report",
    "ad_target_report",
    "ad_search_term_report",
    "ad_search_term_share_report",
    "ad_time_trend_report",
    "ad_promoted_product_report",
    "ad_purchased_product_report",
)
ALL_REPORT_TYPES: tuple[str, ...] = A_TABLE_REPORT_TYPES + C_TABLE_REPORT_TYPES
ReportTypeLiteral = Literal[
    "sales_report",
    "business_report",
    "payment_report",
    "inventory_report",
    "return_report",
    "ad_budget_report",
    "ad_campaign_report",
    "ad_placement_report",
    "ad_invalid_traffic_report",
    "ad_target_report",
    "ad_search_term_report",
    "ad_search_term_share_report",
    "ad_time_trend_report",
    "ad_promoted_product_report",
    "ad_purchased_product_report",
]


class AutoReportRecognizeRequest(BaseModel):
    folder_name: str = Field(min_length=1, max_length=80, description="Parent folder of the report file (used for project fallback matching).")
    original_filename: str = Field(min_length=1, max_length=255)
    country: str = Field(default="US", min_length=2, max_length=2)
    report_type: ReportTypeLiteral
    matched_columns: list[str] = Field(default_factory=list)
    row_count_preview: int = Field(ge=0, le=10_000_000)
    detected_date: str | None = Field(default=None, max_length=10)
    detected_start_date: str | None = Field(default=None, max_length=10)
    detected_end_date: str | None = Field(default=None, max_length=10)
    warnings: list[str] = Field(default_factory=list)


class AutoReportRecognizeResponse(BaseModel):
    project_id: int
    project_name: str
    report_type: ReportTypeLiteral
    report_label: str
    match_status: Literal["matched", "unmatched", "conflict", "manual"]
    match_message: str
    matched_by: str
    candidate_projects: list[str] = Field(default_factory=list)
    can_ingest: bool


class IngestScopePayload(BaseModel):
    scope_date: _date
    row_count_preview: int = Field(ge=0, le=10_000_000)
    scope_rows: list[dict[str, object]] = Field(default_factory=list)


class AutoReportIngestRequest(BaseModel):
    report_type: ReportTypeLiteral
    project_id: int = Field(ge=1)
    country: str = Field(default="US", min_length=2, max_length=2)
    original_filename: str = Field(min_length=1, max_length=255)
    file_sha256: str = Field(min_length=64, max_length=64, pattern=r"^[0-9a-f]{64}$")
    file_size_bytes: int = Field(ge=0, le=500_000_000)
    local_file_path: str = Field(min_length=1, max_length=1024)
    matched_columns: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    report_label: str = Field(min_length=1, max_length=120)
    report_date: _date | None = None
    scopes: list[IngestScopePayload] = Field(min_length=1)
    operator: str = Field(default="autoReportUpload", min_length=1, max_length=80)


class AutoReportIngestResponse(BaseModel):
    status: Literal["created", "duplicate", "noop"]
    report_type: ReportTypeLiteral
    project_id: int
    source_table: Literal["A", "C"]
    source_id: int
    version: int
    duplicate_match_table: Literal["A", "C", "log"] | None = None
    duplicate_source_id: int | None = None
    message: str


class AutoReportHeartbeatRequest(BaseModel):
    instance_id: str = Field(min_length=1, max_length=80)
    last_run_ts: str = Field(min_length=14, max_length=14, pattern=r"^\d{14}$")
    last_status: Literal["ok", "warning", "error"]
    detail: str = Field(default="", max_length=500)
    operator: str = Field(default="autoReportUpload", min_length=1, max_length=80)


class AutoReportHeartbeatResponse(BaseModel):
    accepted: bool
    last_heartbeat_id: int