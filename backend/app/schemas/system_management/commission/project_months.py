"""
项目月度佣金 Schema。
"""
from pydantic import BaseModel, Field

from app.schemas.system_management.commission._enums import (
    CommissionProjectPaymentStatus,
)


class CommissionProjectMonthItem(BaseModel):
    id: int
    report_month: str
    project_id: int
    project_name: str
    income_total_usd: float
    factory_commission_rate: float
    usd_to_rmb_rate: float
    factory_commission_usd: float
    factory_commission_rmb: float
    payment_status: CommissionProjectPaymentStatus
    received_rmb: float
    payment_confirmed_at: str | None = None
    payment_confirmed_by: str | None = None
    note: str | None = None
    computed_at: str
    updated_at: str


class CommissionProjectMonthsResponse(BaseModel):
    report_month: str
    items: list[CommissionProjectMonthItem] = Field(default_factory=list)


class UpdateCommissionProjectPaymentRequest(BaseModel):
    payment_status: CommissionProjectPaymentStatus
    received_rmb: float = Field(ge=0)
    note: str | None = Field(default=None, max_length=500)


class UpdateCommissionProjectPaymentResponse(BaseModel):
    item: CommissionProjectMonthItem