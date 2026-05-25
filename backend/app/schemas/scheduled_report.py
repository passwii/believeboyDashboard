"""Scheduled Report Pydantic Schemas."""

from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field, model_validator


class SubscriptionCreate(BaseModel):
    email: str = Field(..., max_length=256, description="接收报告的邮箱地址")
    project_ids: str = Field(default="*", max_length=500, description="项目 ID 列表，逗号分隔，* 表示全部")
    country: str = Field(default="US", max_length=10)
    frequency: str = Field(..., pattern="^(daily|weekly|monthly)$")
    dispatch_hour: int = Field(default=15, ge=0, le=23, description="发送时间（小时，0-23，北京时间）")
    dispatch_minute: int = Field(default=0, ge=0, le=59, description="发送时间（分钟，0-59）")
    dispatch_weekday: Optional[int] = Field(default=None, ge=0, le=6, description="周报发送日（0=周一..6=周日）")
    dispatch_day: Optional[int] = Field(default=None, ge=2, le=28, description="月报发送日（2-28）")
    ai_model: Optional[str] = Field(default=None, max_length=64, description="AI 摘要使用的模型，空则用默认模型")

    @model_validator(mode="after")
    def validate_frequency_fields(self) -> "SubscriptionCreate":
        if self.frequency == "weekly":
            if self.dispatch_weekday is None:
                self.dispatch_weekday = 0  # 默认周一
            # 周一 16:00 之前不允许
            if self.dispatch_weekday == 0 and self.dispatch_hour < 16:
                raise ValueError("周报最早可在周一 16:00 发送")
        elif self.frequency == "monthly":
            if self.dispatch_day is None:
                self.dispatch_day = 2  # 默认 2 号
        return self


class SubscriptionUpdate(BaseModel):
    email: Optional[str] = Field(default=None, max_length=256)
    project_ids: Optional[str] = Field(default=None, max_length=500)
    country: Optional[str] = Field(default=None, max_length=10)
    frequency: Optional[str] = Field(default=None, pattern="^(daily|weekly|monthly)$")
    dispatch_hour: Optional[int] = Field(default=None, ge=0, le=23, description="发送时间（小时，0-23，北京时间）")
    dispatch_minute: Optional[int] = Field(default=None, ge=0, le=59, description="发送时间（分钟，0-59）")
    dispatch_weekday: Optional[int] = Field(default=None, ge=0, le=6, description="周报发送日（0=周一..6=周日）")
    dispatch_day: Optional[int] = Field(default=None, ge=2, le=28, description="月报发送日（2-28）")
    ai_model: Optional[str] = Field(default=None, max_length=64)
    enabled: Optional[bool] = None

    @model_validator(mode="after")
    def validate_frequency_fields(self) -> "SubscriptionUpdate":
        if self.frequency == "weekly" and self.dispatch_weekday is not None:
            if self.dispatch_weekday == 0 and self.dispatch_hour is not None and self.dispatch_hour < 16:
                raise ValueError("周报最早可在周一 16:00 发送")
        if self.frequency == "monthly" and self.dispatch_day is not None:
            if self.dispatch_day < 2:
                raise ValueError("月报最早可在每月 2 号发送")
        return self


class SubscriptionItem(BaseModel):
    id: int
    user_id: Optional[int]
    email: str
    project_ids: str
    country: str
    frequency: str
    dispatch_hour: int = 15
    dispatch_minute: int = 0
    dispatch_weekday: Optional[int] = None
    dispatch_day: Optional[int] = None
    ai_model: Optional[str] = None
    enabled: bool
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class SubscriptionListResponse(BaseModel):
    items: list[SubscriptionItem]
    total: int


DeliveryStageValue = Literal["pending", "preparing", "building", "sending", "done", "failed"]
"""DeliveryLogItem stage 可选值: pending/preparing/building/sending/done/failed"""


class DeliveryLogItem(BaseModel):
    id: int
    subscription_id: int
    frequency: str
    report_date: str
    report_month: Optional[str]
    email: str
    status: str
    stage: DeliveryStageValue = "pending"
    error_message: Optional[str]
    sent_at: Optional[datetime]
    screenshot_r2_key: Optional[str] = None
    screenshot_r2_url: Optional[str] = None
    screenshot_r2_thumb_key: Optional[str] = None
    screenshot_r2_thumb_url: Optional[str] = None
    ai_summary: Optional[str] = None
    created_at: datetime

    model_config = {"from_attributes": True}


class DeliveryLogListResponse(BaseModel):
    items: list[DeliveryLogItem]
    total: int


class TestEmailRequest(BaseModel):
    email: str = Field(..., max_length=256)
    frequency: str = Field(default="daily", pattern="^(daily|weekly|monthly)$")
    project_ids: str = Field(default="*", max_length=500, description="项目 ID 列表，逗号分隔，* 表示全部")
    country: str = Field(default="US", max_length=10)
    ai_model: Optional[str] = Field(default=None, max_length=64, description="AI 摘要使用的模型，空则用默认模型")


class TestEmailResponse(BaseModel):
    success: bool
    message: str
    resend_id: Optional[str] = None


class TriggerReportResponse(BaseModel):
    success: bool
    frequency: str
    subscriptions_affected: int
    message: str


LedgerStatusValue = Literal["sent", "failed", "missing"]
LedgerFrequencyValue = Literal["daily", "weekly", "monthly"]


class LedgerSummary(BaseModel):
    expected: int
    sent: int
    failed: int
    missing: int
    resendable: int


class LedgerItem(BaseModel):
    id: int
    ledger_key: str
    expected_date: str
    expected_at: datetime
    frequency: LedgerFrequencyValue
    subscription_id: int
    email: str
    project_ids: str
    project_names: list[str] = Field(default_factory=list)
    country: str
    status: LedgerStatusValue
    latest_delivery_log_id: Optional[int] = None
    error_message: Optional[str] = None
    sent_at: Optional[datetime] = None
    can_resend: bool
    last_checked_at: datetime
    screenshot_r2_url: Optional[str] = None
    screenshot_r2_thumb_url: Optional[str] = None
    ai_summary: Optional[str] = None

    model_config = {"from_attributes": True}


class LedgerListResponse(BaseModel):
    items: list[LedgerItem]
    total: int
    summary: LedgerSummary


class LedgerResendResponse(BaseModel):
    success: bool
    ledger_key: str
    delivery_log_id: Optional[int] = None
    status: str
    message: str
