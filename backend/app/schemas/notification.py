"""Notification schemas for API request/response."""

from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

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
    """subscription_id is in the path, not in the body."""
    test_recipients: list[str] | None = None


class TestEmailResponse(BaseModel):
    success: bool
    message: str
    resend_id: str | None = None

# === P2 通知中心 schemas (Task 2) ===

class NotificationItem(BaseModel):
    id: int
    user_id: int
    type: str
    title: str
    message: Optional[str] = None
    data: Optional[dict] = None
    read: bool
    read_at: Optional[datetime] = None
    created_at: datetime

    model_config = {"from_attributes": True}


class NotificationListResponse(BaseModel):
    items: list[NotificationItem]
    total: int
    page: int
    page_size: int


class UnreadCountResponse(BaseModel):
    count: int

