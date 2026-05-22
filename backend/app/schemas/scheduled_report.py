"""Scheduled Report Pydantic Schemas."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


class SubscriptionCreate(BaseModel):
    email: str = Field(..., max_length=256, description="接收报告的邮箱地址")
    project_ids: str = Field(default="*", max_length=500, description="项目 ID 列表，逗号分隔，* 表示全部")
    country: str = Field(default="US", max_length=10)
    frequency: str = Field(..., pattern="^(daily|weekly|monthly)$")
    ai_model: Optional[str] = Field(default=None, max_length=64, description="AI 摘要使用的模型，空则用默认模型")


class SubscriptionUpdate(BaseModel):
    email: Optional[str] = Field(default=None, max_length=256)
    project_ids: Optional[str] = Field(default=None, max_length=500)
    country: Optional[str] = Field(default=None, max_length=10)
    frequency: Optional[str] = Field(default=None, pattern="^(daily|weekly|monthly)$")
    ai_model: Optional[str] = Field(default=None, max_length=64)
    enabled: Optional[bool] = None


class SubscriptionItem(BaseModel):
    id: int
    user_id: Optional[int]
    email: str
    project_ids: str
    country: str
    frequency: str
    ai_model: Optional[str] = None
    enabled: bool
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class SubscriptionListResponse(BaseModel):
    items: list[SubscriptionItem]
    total: int


class DeliveryLogItem(BaseModel):
    id: int
    subscription_id: int
    frequency: str
    report_date: str
    report_month: Optional[str]
    email: str
    status: str
    error_message: Optional[str]
    sent_at: Optional[datetime]
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
