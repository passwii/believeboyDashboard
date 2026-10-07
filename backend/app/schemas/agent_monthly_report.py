"""Agent 月报写入请求及安全的月报读取响应模型。"""

from __future__ import annotations

from datetime import datetime
from typing import Generic, TypeVar

from pydantic import BaseModel, Field

from app.models.job import JobStatus
from app.schemas.monthly_report import (
    MonthlyFinancialAccountingDetailResponse,
    MonthlyFinancialSeriesResponse,
)

T = TypeVar("T")


class MonthlyReportAgentOkResponse(BaseModel, Generic[T]):
    """Typed OpenAPI envelope matching the Agent JSON success shell."""

    ok: bool = True
    data: T


class AgentMonthlyReportListItem(BaseModel):
    """Public monthly report fields; internal storage paths are never exposed."""

    id: int
    project_id: int
    project_name: str
    country: str
    report_month: str
    version: int
    is_current: bool
    superseded_at: datetime | None
    status: JobStatus
    settlement_id: str | None
    total_transactions: int
    total_orders: int
    total_refunds: int
    total_adjustments: int
    total_service_fees: int
    total_trans_fees: int
    result_file_path: str | None
    error_message: str | None
    calculation_version: int
    computed_at: datetime | None
    created_at: datetime | None
    updated_at: datetime | None


class AgentMonthlyReportDetail(BaseModel):
    report: AgentMonthlyReportListItem
    pt3: dict[str, float] | None
    pt4: dict[str, float] | None


MonthlyReportListEnvelope = MonthlyReportAgentOkResponse[list[AgentMonthlyReportListItem]]
MonthlyReportDetailEnvelope = MonthlyReportAgentOkResponse[AgentMonthlyReportDetail]
MonthlyFinancialSeriesEnvelope = MonthlyReportAgentOkResponse[MonthlyFinancialSeriesResponse]
MonthlyFinancialAccountingDetailEnvelope = MonthlyReportAgentOkResponse[
    MonthlyFinancialAccountingDetailResponse
]


class MonthlyReportUploadCreateRequest(BaseModel):
    """建临时上传会话：项目名从服务端项目记录解析，客户端只给 id。"""

    project_id: int = Field(gt=0)
    country: str = Field(default="US", max_length=8)
    report_month: str = Field(min_length=7, max_length=7, description="YYYY-MM")


class MonthlyReportBuildCreateRequest(BaseModel):
    """发起仅计算草稿：引用会话内已上传的不透明 file_id。"""

    upload_id: int = Field(gt=0)
    transaction_file_id: str = Field(min_length=1, max_length=64)
    summary_pdf_file_id: str | None = Field(default=None, max_length=64)


__all__ = [
    "AgentMonthlyReportDetail",
    "AgentMonthlyReportListItem",
    "MonthlyFinancialAccountingDetailEnvelope",
    "MonthlyFinancialSeriesEnvelope",
    "MonthlyReportBuildCreateRequest",
    "MonthlyReportDetailEnvelope",
    "MonthlyReportListEnvelope",
    "MonthlyReportUploadCreateRequest",
]
