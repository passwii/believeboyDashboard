"""
佣金记录 Schema。
"""
from pydantic import BaseModel, Field

from app.schemas.system_management.commission._enums import (
    CommissionIncomeCategory,
    CommissionPaymentStatus,
    CommissionRatioSource,
)


class CommissionRecordUpsertItem(BaseModel):
    project_id: int = Field(gt=0)
    project_name: str = Field(min_length=1, max_length=255)
    person_name: str = Field(min_length=1, max_length=255)
    income_category: CommissionIncomeCategory
    income_total_usd: float = Field(ge=0)
    factory_commission_rate: float = Field(ge=0, le=1)
    operator_bonus_ratio: float = Field(ge=0, le=1)
    bonus_amount_usd: float = Field(ge=0)
    usd_to_rmb_rate: float = Field(ge=0)
    bonus_amount_rmb: float = Field(ge=0)
    bonus_ratio_source: CommissionRatioSource = CommissionRatioSource.rule
    manual_bonus_ratio: float | None = Field(default=None, ge=0, le=1)


class UpsertCommissionRecordsRequest(BaseModel):
    report_month: str = Field(min_length=7, max_length=7)
    items: list[CommissionRecordUpsertItem] = Field(default_factory=list)


class CommissionRecordItem(BaseModel):
    id: int
    report_month: str
    country: str = "US"
    project_id: int
    project_name: str
    project_month_id: int | None = None
    person_name: str
    income_category: CommissionIncomeCategory
    income_total_usd: float
    factory_commission_rate: float
    operator_bonus_ratio: float
    bonus_amount_usd: float
    usd_to_rmb_rate: float
    bonus_amount_rmb: float
    bonus_ratio_source: CommissionRatioSource
    manual_bonus_ratio: float | None = None
    payment_status: CommissionPaymentStatus
    payment_confirmed_at: str | None = None
    payment_confirmed_by: str | None = None
    is_locked: bool = False
    locked_at: str | None = None
    locked_by: str | None = None
    is_active: bool = True
    deactivated_at: str | None = None
    computed_at: str
    updated_at: str


class CommissionRecordsResponse(BaseModel):
    report_month: str
    items: list[CommissionRecordItem] = Field(default_factory=list)


class UpdateCommissionPaymentStatusRequest(BaseModel):
    payment_status: CommissionPaymentStatus


class UpdateCommissionPaymentStatusResponse(BaseModel):
    item: CommissionRecordItem