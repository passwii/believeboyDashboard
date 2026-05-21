from datetime import date, datetime
from decimal import Decimal
from typing import Any

from pydantic import BaseModel, Field


class PlatformRevenueAttachment(BaseModel):
    id: str
    filename: str
    url: str
    size: int
    created_at: datetime
    stored_path: str | None = None
    key: str | None = None
    thumb_url: str | None = None


class PlatformRevenueItem(BaseModel):
    id: int
    project_id: int
    project_name: str
    country: str
    received_date: date
    amount: Decimal
    currency: str = "USD"
    exchange_rate: Decimal | None = None
    revenue_type: str = "订单回款"
    note: str | None = None
    attachments: list[PlatformRevenueAttachment] = []
    screenshot_r2_key: str | None = None
    screenshot_r2_url: str | None = None
    created_by: str
    created_at: datetime
    updated_at: datetime


class PlatformRevenueListResponse(BaseModel):
    items: list[PlatformRevenueItem]
    total: int
    page: int
    page_size: int
    total_pages: int


class PlatformRevenueCreate(BaseModel):
    project_id: int = Field(gt=0)
    country: str = Field(min_length=1, max_length=10)
    received_date: date
    amount: Decimal = Field(gt=0)
    currency: str = Field(default="USD", max_length=10)
    exchange_rate: Decimal | None = Field(default=None, ge=0)
    revenue_type: str = Field(default="订单回款", max_length=20)
    note: str | None = None
    attachments: list[PlatformRevenueAttachment] = Field(default_factory=list)
    screenshot_r2_key: str | None = None
    screenshot_r2_url: str | None = None


class PlatformRevenueUpdate(BaseModel):
    country: str | None = Field(default=None, max_length=10)
    received_date: date | None = None
    amount: Decimal | None = Field(default=None, gt=0)
    currency: str | None = Field(default=None, max_length=10)
    exchange_rate: Decimal | None = Field(default=None, ge=0)
    revenue_type: str | None = Field(default=None, max_length=20)
    note: str | None = None
    attachments: list[PlatformRevenueAttachment] | None = None
    screenshot_r2_key: str | None = None
    screenshot_r2_url: str | None = None