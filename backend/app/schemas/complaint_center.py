"""客诉中心 Pydantic schema（BLF-981）。"""

from __future__ import annotations

from datetime import date, datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field


# ── 共用子结构 ──────────────────────────────────────────────────

class RunSummary(BaseModel):
    total_needs_reply: int = 0
    total_reported_unresolved: int = 0
    shops_with_pending: int = 0


class ShopMetrics(BaseModel):
    needs_reply: int = 0
    reported_unresolved: int = 0
    resolved_total: int = 0
    resolved_today: int = 0


class Triage(BaseModel):
    category: Annotated[str, Field(pattern='^(with_order|no_order_info|spam)$')]
    has_order: bool
    summary_zh: str = ''


class OrderInfo(BaseModel):
    order_id: str
    asin: str
    product_title: str
    qty: int = 1
    purchased_at: datetime | None = None
    shipped_at: datetime | None = None
    delivered_at: datetime | None = None


class SlaInfo(BaseModel):
    reply_deadline: datetime | None = None
    expires_soon: bool = False


# ── batch 写入请求 ──────────────────────────────────────────────

class ShopCheckIn(BaseModel):
    project_id: int
    country: Annotated[str, Field(pattern='^(US|DE|GB|UK)$')] = 'US'
    check_status: Annotated[str, Field(pattern='^(ok|login_page|launch_fail|identity_mismatch)$')] = 'ok'
    error_message: str | None = None
    metrics: ShopMetrics = Field(default_factory=ShopMetrics)


class ComplaintIn(BaseModel):
    project_id: int
    country: Annotated[str, Field(pattern='^(US|DE|GB|UK)$')] = 'US'
    first_message_date: date
    message_date: date
    buyer_name: str = Field(max_length=255)
    subject: str = Field(max_length=512)
    message_body: str
    triage: Triage
    order: OrderInfo | None = None
    sla: SlaInfo | None = None
    message_count: int = Field(default=1, ge=1)


class ComplaintRunBatchRequest(BaseModel):
    run_date: date
    trigger: Annotated[str, Field(pattern='^(autopilot|manual)$')] = 'autopilot'
    shops_total: int = Field(ge=0)
    shops_checked: int = Field(ge=0)
    shops_failed: list[str] = Field(default_factory=list)
    summary: RunSummary = Field(default_factory=RunSummary)
    shop_checks: list[ShopCheckIn] = Field(default_factory=list)
    complaints: list[ComplaintIn] = Field(default_factory=list)


# ── batch 响应 ──────────────────────────────────────────────────

class ShopCheckOut(BaseModel):
    shop_check_id: int
    project_id: int
    country: str


class ComplaintOut(BaseModel):
    complaint_id: int
    project_id: int
    country: str
    buyer_name: str
    first_message_date: date
    message_date: date


class ComplaintRunBatchResponse(BaseModel):
    run_id: int
    run_date: date
    idempotency_key: str | None = None
    shop_checks: list[ShopCheckOut]
    complaints: list[ComplaintOut]


# ── 列表 / 详情响应 ─────────────────────────────────────────────

ComplaintStatus = Literal['pending', 'drafted', 'replied', 'resolved', 'closed_no_response']
ComplaintCategory = Literal['with_order', 'no_order_info', 'spam']


class ComplaintStatusHistoryEntry(BaseModel):
    from_status: ComplaintStatus | None = Field(default=None, alias='from')
    to: ComplaintStatus
    at: datetime
    by: str

    model_config = ConfigDict(populate_by_name=True)


class ComplaintListItem(BaseModel):
    """列表 DTO，包含前端映射层需要的原始快照字段。"""

    model_config = ConfigDict(from_attributes=True)

    id: int
    run_id: int
    project_id: int
    project_name: str
    country: str
    buyer_name: str
    first_message_date: date
    message_date: date
    subject: str
    category: ComplaintCategory
    has_order: bool
    status: ComplaintStatus
    triage: Triage
    order_info: OrderInfo | None = None
    sla: SlaInfo | None = None
    status_history: list[ComplaintStatusHistoryEntry] = Field(default_factory=list)
    draft_path: str | None = None
    reply_sent_at: datetime | None = None
    handler_note: str | None = None
    message_count: int
    created_at: datetime
    updated_at: datetime


class ComplaintDetail(ComplaintListItem):
    message_body: str
    messages: list = Field(default_factory=list)


# ── PATCH 请求（状态流转 / 消息更新）──────────────────────────

class ComplaintPatchRequest(BaseModel):
    status: ComplaintStatus | None = None
    draft_path: str | None = None
    reply_sent_at: datetime | None = None
    handler_note: str | None = None


class ComplaintMessageUpdate(BaseModel):
    message_date: date
    message_body: str
    triage: Triage | None = None
    order: OrderInfo | None = None
    sla: SlaInfo | None = None


# ── 概览响应 ────────────────────────────────────────────────────

class OverviewMetrics(BaseModel):
    total_needs_reply: int = 0
    total_reported_unresolved: int = 0
    total_resolved: int = 0
    sla_due_soon: int = 0
    sla_overdue: int = 0


class OverviewTrendPoint(BaseModel):
    date: date
    needs_reply: int


class OverviewProjectRow(BaseModel):
    project_id: int
    project_name: str
    country: str
    check_status: str
    needs_reply: int
    resolved: int
    sla_due_soon: int
    sla_overdue: int


class OverviewResponse(BaseModel):
    date: date
    metrics: OverviewMetrics
    trend: list[OverviewTrendPoint]
    projects: list[OverviewProjectRow]
