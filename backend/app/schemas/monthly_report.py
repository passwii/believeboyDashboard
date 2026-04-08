from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field, model_validator

from app.models.job import JobStatus


class CreateMonthlyReportRequest(BaseModel):
    project_id: int | None = Field(default=None, gt=0)
    project_name: str | None = Field(default=None, min_length=1, max_length=128)
    report_month: str = Field(min_length=7, max_length=7)
    transaction_file_id: str = Field(min_length=1)
    summary_pdf_file_id: str | None = Field(default=None, min_length=1)

    @model_validator(mode='after')
    def validate_project_selector(self) -> 'CreateMonthlyReportRequest':
        if self.project_id is None and not (self.project_name or '').strip():
            raise ValueError('project_id or project_name is required')
        return self


class MonthlyReportResponse(BaseModel):
    job_id: int
    monthly_report_id: int | None
    status_endpoint: str | None = None
    result_endpoint: str
    status: JobStatus
    created_at: datetime | None


class MonthlyReportTaskStatusResponse(BaseModel):
    task_id: int
    status: JobStatus
    stage: str
    progress: int
    message: str | None
    error_message: str | None
    persistence_status: str
    persistence_message: str | None
    created_at: datetime
    updated_at: datetime


class MonthlyReportListItem(BaseModel):
    id: int
    project_id: int
    project_name: str
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

class MonthlyReportDetailResponse(BaseModel):
    report: MonthlyReportListItem
    pt3: dict[str, float] | None
    pt4: dict[str, float] | None


class MonthlyFinancialSeriesRow(BaseModel):
    report_month: str
    income_sales: float
    income_refund: float
    income_adjustment: float
    income_other: float
    expense_selling_fee: float
    expense_fba_fee: float
    expense_inventory_fee: float
    expense_service_fee: float
    expense_advertising: float
    expense_other_fees: float
    income_total: float
    expense_total: float
    amazon_pay_back: float
    credit_card_deduction_usd: float = 0.0
    fob_cost_rmb: float = 0.0
    first_leg_cost_rmb: float = 0.0
    has_source_report: bool


class MonthlyFinancialTrendPoint(BaseModel):
    report_month: str
    income_total: float
    expense_total: float
    amazon_pay_back: float
    net_amount: float
    has_source_report: bool


class MonthlyFinancialTrend(BaseModel):
    income_total_sum: float
    expense_total_sum: float
    amazon_pay_back_sum: float
    net_amount_sum: float
    points: list[MonthlyFinancialTrendPoint]


class MonthlyFinancialSeriesResponse(BaseModel):
    project_id: int
    project_name: str
    start_month: str
    end_month: str
    rows: list[MonthlyFinancialSeriesRow]
    trend: MonthlyFinancialTrend


class MonthlyFinancialAccountingLine(BaseModel):
    income_en: str
    income_zh: str
    income_amount_usd: float
    income_source: str
    expense_en: str
    expense_zh: str
    expense_amount_usd: float
    expense_source: str


class MonthlyFinancialAccountingDetailResponse(BaseModel):
    project_id: int
    project_name: str
    report_month: str
    rows: list[MonthlyFinancialAccountingLine]
