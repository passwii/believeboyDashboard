"""
佣金比例覆盖 Schema。
"""
from pydantic import BaseModel, Field

from app.schemas.system_management.commission._enums import CommissionIncomeCategory


class CommissionRatioOverrideItem(BaseModel):
    id: int
    report_month: str
    project_id: int
    project_name: str
    person_name: str
    income_category: CommissionIncomeCategory
    override_ratio: float
    reason: str | None = None
    updated_by: str | None = None
    updated_at: str


class UpsertCommissionRatioOverrideItem(BaseModel):
    project_id: int = Field(gt=0)
    project_name: str = Field(min_length=1, max_length=255)
    person_name: str = Field(min_length=1, max_length=255)
    income_category: CommissionIncomeCategory
    override_ratio: float = Field(ge=0, le=1)
    reason: str | None = Field(default=None, max_length=500)


class UpsertCommissionRatioOverridesRequest(BaseModel):
    report_month: str = Field(min_length=7, max_length=7)
    items: list[UpsertCommissionRatioOverrideItem] = Field(default_factory=list)


class CommissionRatioOverridesResponse(BaseModel):
    report_month: str
    items: list[CommissionRatioOverrideItem] = Field(default_factory=list)