from pydantic import BaseModel, Field
from typing import Literal


class UploadResponse(BaseModel):
    file_id: str
    file_path: str
    filename: str
    original_filename: str
    size: int


ProjectMatchStatus = Literal["unmatched", "matched", "conflict", "manual"]
ReportUploadType = Literal[
    "inventory_report",
    # 旧值仅保留给历史调用方（入库层仍按表头路由），新识别不再输出。
    "inventory_ledger",
    "inventory_ledger_summary",
    "inventory_ledger_detail",
    "business_report",
    "ad_product_report",
    "ad_report",
    "ad_search_term_report",
    "sales_report",
    "payment_report",
    "return_report",
    # BLF-975 复测：广告 B 表 10 子类型（/agent/upload/validate 复用 ad specs
    # 识别器；commit 广告域继续由 /ad-upload/commit 承担，此处仅 validate）。
    "ad_promoted_product_report",
    "ad_purchased_product_report",
    "ad_campaign_report",
    "ad_budget_report",
    "ad_invalid_traffic_report",
    "ad_placement_report",
    "ad_target_report",
    "ad_time_trend_report",
    "unknown",
]
DateInputMode = Literal[
    "single_manual",
    "single_auto",
    "single_detected",
    "range_manual",
    "range_auto",
    "multi_auto",
]


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
    status: Literal["recognized", "unsupported", "error"]
    country: str = "US"
    # Multi-country detection for European sales reports
    detected_countries: list[str] = Field(
        default_factory=list, description="All countries detected in file"
    )
    primary_country: str | None = Field(
        default=None, description="Primary country for single-country files"
    )
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
    country: str = "US"
    use_period_dates: bool = False
    # True 时仅做识别校验 + 临时文件复制，不写入 analysis_source_files /
    # analysis_*_rows 表，不写 ReportUploadLog；用于产品分析手动核算/临时核算
    # "识别+计算"场景。返回 status='skipped' + persisted_source_id=None。
    dry_run: bool = False


class ReportCommitResponse(BaseModel):
    report_type: ReportUploadType
    status: Literal["saved", "persisted", "skipped"]
    project_name: str | None = None
    country: str = "US"
    report_date: str | None = None
    report_start_date: str | None = None
    report_end_date: str | None = None
    file_id: str
    file_path: str
    persisted_source_id: int | None = None
    persisted_table: str | None = None
    message: str
    duplicate_warnings: list[dict] = Field(default_factory=list)
    # 按行入库的报表（库存盘点 / 库存分类账）返回实际入库行数；
    # 其他类型保持 None（可选字段，向后兼容）。
    rows_ingested: int | None = Field(
        default=None, description="实际入库行数（仅按行入库的报表类型非空）"
    )


class ReportStatusCell(BaseModel):
    report_type: ReportUploadType
    status: Literal["available", "missing", "saved_only"]
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
    country: str = "US"
    items: list[ProjectReportStatusItem]


# ─── Agent Upload (BLF-975) ────────────────────────────────────────────────
class AgentUploadValidateResponse(BaseModel):
    """Dry-run 校验响应：列匹配度、检测国家、行数估算。

    BLF-975 复测：``temp_file_id`` 必返回——validate 即临时文件登记步骤，
    commit 用它两段式衔接（此前缺失导致 agent 流接不上）。
    """

    temp_file_id: str
    original_filename: str = ""
    report_type: ReportUploadType
    status: Literal["valid", "invalid", "warning"] = "valid"
    matched_columns: list[str] = Field(default_factory=list)
    missing_columns: list[str] = Field(default_factory=list)
    column_match_ratio: float = Field(
        default=0.0, ge=0.0, le=1.0, description="列匹配度 (0.0-1.0)"
    )
    detected_countries: list[str] = Field(default_factory=list)
    primary_country: str = "US"
    row_count_preview: int | None = None
    date_input_mode: DateInputMode = "single_manual"
    detected_date: str | None = None
    detected_start_date: str | None = None
    detected_end_date: str | None = None
    suggested_report_type: ReportUploadType | None = Field(
        default=None, description="列不匹配时建议的报表类型"
    )
    warnings: list[str] = Field(default_factory=list)


class AgentUploadCommitRequest(ReportCommitRequest):
    """agent 通道正式提交请求：同 ``ReportCommitRequest`` 契约。

    继承保证 agent 调用可直接透传给 ``commit_report_upload``（服务层签名
    只认 ``ReportCommitRequest``）；``dry_run`` 字段一并继承（agent 不用，
    但服务层契约对齐）。
    """


class AgentUploadCommitResponse(ReportCommitResponse):
    """agent 通道正式提交响应：同 ``ReportCommitResponse`` 契约。"""
