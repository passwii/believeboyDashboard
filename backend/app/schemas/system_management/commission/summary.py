"""
佣金汇总 Schema。
"""
from pydantic import BaseModel, Field


class CommissionYearlyMonthlySummaryItem(BaseModel):
    report_month: str
    income_total_usd: float
    factory_commission_usd: float
    factory_commission_rmb: float
    received_rmb: float
    receive_rate: float


class CommissionYearlyMonthlySummaryResponse(BaseModel):
    year: str
    items: list[CommissionYearlyMonthlySummaryItem] = Field(default_factory=list)


class CommissionProjectMonthlySummaryMonthItem(BaseModel):
    report_month: str
    income_total_usd: float
    factory_commission_rmb: float
    received_rmb: float
    receive_rate: float


class CommissionProjectYearlySummaryItem(BaseModel):
    project_id: int
    project_name: str
    months: dict[str, CommissionProjectMonthlySummaryMonthItem] = Field(
        default_factory=dict
    )
    total_income_usd: float
    total_commission_rmb: float
    total_received_rmb: float
    receive_rate: float


class CommissionProjectYearlySummaryResponse(BaseModel):
    year: str
    items: list[CommissionProjectYearlySummaryItem] = Field(default_factory=list)


class RecomputeCommissionRequest(BaseModel):
    report_month: str = Field(min_length=7, max_length=7)


class RecomputeCommissionResponse(BaseModel):
    report_month: str
    project_month_count: int
    record_count: int
    locked_record_count: int
    computed_at: str