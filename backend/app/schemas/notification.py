"""Notification schemas for API request/response."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class SubscriptionCreate(BaseModel):
    project_id: int
    rule_name: str = Field(max_length=128)
    frequency: Literal["daily", "weekly", "monthly"]
    report_types: list[str] = Field(default_factory=list)
    recipients: list[str] = Field(default_factory=list)
    enabled: bool = True


class SubscriptionUpdate(BaseModel):
    rule_name: str | None = None
    frequency: Literal["daily", "weekly", "monthly"] | None = None
    report_types: list[str] | None = None
    recipients: list[str] | None = None
    enabled: bool | None = None


class SubscriptionItem(BaseModel):
    id: int
    project_id: int
    rule_name: str
    frequency: str
    report_types: list[str]
    recipients: list[str]
    enabled: bool
    created_by: int | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class SubscriptionListResponse(BaseModel):
    items: list[SubscriptionItem]
    total: int


class TestEmailRequest(BaseModel):
    subscription_id: int
    test_recipients: list[str] | None = None


class TestEmailResponse(BaseModel):
    success: bool
    message: str
    resend_id: str | None = None