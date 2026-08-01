"""CRM API schemas (Pydantic v2)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Scope = Literal["mine", "all", "sea"]


# ---------- Customer ----------
class CustomerCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    short_name: str | None = None
    industry: str | None = None
    customer_type: str | None = None  # 对象类型: 工厂/贸易商/同行/其他
    interested_service: str | None = None  # 意向服务: 代运营/AI运营/运营服务/其他
    rating: str = "C"
    status: str = "active"
    source: str | None = None
    owner_id: str | None = None
    address: str | None = None
    website: str | None = None
    annual_revenue: float | None = None
    employee_count: int | None = None
    remark: str | None = None
    # 联系人（contact_name 非空 → 建主联系人；phone/email 附带）
    contact_name: str | None = None
    contact_phone: str | None = None
    contact_email: str | None = None


class CustomerUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    short_name: str | None = None
    industry: str | None = None
    customer_type: str | None = None  # 对象类型: 工厂/贸易商/同行/其他
    interested_service: str | None = None  # 意向服务: 代运营/AI运营/运营服务/其他
    rating: str | None = None
    status: str | None = None
    source: str | None = None
    owner_id: str | None = None
    address: str | None = None
    website: str | None = None
    annual_revenue: float | None = None
    employee_count: int | None = None
    remark: str | None = None


class CustomerSeaImportRow(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str
    short_name: str | None = None
    industry: str | None = None
    customer_type: str | None = None  # 工厂/贸易商/同行/其他
    interested_service: str | None = None  # 代运营/AI运营/运营服务/其他
    rating: str | None = None  # A/B/C/D；None → 默认 C
    status: str | None = None  # active/lost/signed/on_hold；None → active
    source: str | None = None  # referral/exhibition/online_ad/cold_call/other
    address: str | None = None
    website: str | None = None
    annual_revenue: float | None = None
    employee_count: int | None = None
    remark: str | None = None
    contact_name: str | None = None
    contact_phone: str | None = None
    contact_email: str | None = None


class CustomerSeaImportRequest(BaseModel):
    rows: list[CustomerSeaImportRow] = Field(min_length=1, max_length=1000)


class CustomerSeaImportFailItem(BaseModel):
    row: int
    field: str | None = None
    reason: str


class CustomerSeaImportResult(BaseModel):
    created: int
    skipped_dupes: int
    failed: list[CustomerSeaImportFailItem]


class ValueScoresUpdate(BaseModel):
    """P6a 价值评分更新（部分更新：仅写入提供的维度）。

    写入后若 4 维全非空 → 后端重算 rating；任一空 → rating 不动。
    """

    model_config = ConfigDict(extra="forbid")
    score_scale: Literal["A", "B", "C", "D"] | None = None
    score_pay: Literal["A", "B", "C", "D"] | None = None
    score_fit: Literal["A", "B", "C", "D"] | None = None
    score_coop: Literal["A", "B", "C", "D"] | None = None


class CustomerItem(BaseModel):
    id: int
    name: str
    short_name: str | None = None
    industry: str | None = None
    customer_type: str | None = None  # 对象类型: 工厂/贸易商/同行/其他
    interested_service: str | None = None  # 意向服务: 代运营/AI运营/运营服务/其他
    rating: str
    # P6a: 4 维价值评分（主观判断）。rating 由 4 维汇总自动计算（见 value_score_service.compute_rating）。
    score_scale: str | None = None
    score_pay: str | None = None
    score_fit: str | None = None
    score_coop: str | None = None
    status: str
    source: str | None = None
    owner_id: str | None = None
    owner_name: str | None = None
    # 来自 primary contact 的 join 计算字段（前端 Customer.contactName/Phone/Email 映射自这里）
    contact_name: str | None = None
    contact_phone: str | None = None
    contact_email: str | None = None
    contact_wechat: str | None = None
    address: str | None = None
    website: str | None = None
    annual_revenue: float | None = None
    employee_count: int | None = None
    remark: str | None = None
    last_follow_at: datetime | None = None
    next_follow_at: datetime | None = None
    created_by: str | None = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class CustomerListResponse(BaseModel):
    items: list[CustomerItem]
    total: int
    page: int
    page_size: int


# ---------- Contact ----------
class ContactCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    phone: str | None = None
    email: str | None = None
    wechat: str | None = None
    title: str | None = None
    is_primary: bool = False
    remark: str | None = None


class ContactUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    phone: str | None = None
    email: str | None = None
    wechat: str | None = None
    title: str | None = None
    is_primary: bool | None = None
    remark: str | None = None


class ContactItem(BaseModel):
    id: int
    customer_id: int
    name: str
    phone: str | None = None
    email: str | None = None
    wechat: str | None = None
    title: str | None = None
    is_primary: bool
    remark: str | None = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


# ---------- Lead ----------
class LeadCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    company: str | None = None
    phone: str | None = None
    email: str | None = None
    wechat: str | None = None
    source: str | None = None
    status: str = "new"
    intent: str = "medium"
    customer_type: str | None = None  # 对象类型: 工厂/贸易商/同行/其他
    interested_service: str | None = None  # 意向服务: 代运营/AI运营/运营服务/其他
    owner_id: str | None = None
    expected_amount: float | None = None
    expected_close_date: str | None = None
    remark: str | None = None


class LeadUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    company: str | None = None
    phone: str | None = None
    email: str | None = None
    wechat: str | None = None
    source: str | None = None
    status: str | None = None
    intent: str | None = None
    customer_type: str | None = None  # 对象类型: 工厂/贸易商/同行/其他
    interested_service: str | None = None  # 意向服务: 代运营/AI运营/运营服务/其他
    owner_id: str | None = None
    expected_amount: float | None = None
    expected_close_date: str | None = None
    remark: str | None = None


class LeadItem(BaseModel):
    id: int
    name: str
    company: str | None = None
    phone: str | None = None
    email: str | None = None
    wechat: str | None = None
    source: str | None = None
    status: str
    intent: str
    customer_type: str | None = None  # 对象类型: 工厂/贸易商/同行/其他
    interested_service: str | None = None  # 意向服务: 代运营/AI运营/运营服务/其他
    owner_id: str | None = None
    owner_name: str | None = None
    expected_amount: float | None = None
    expected_close_date: str | None = None
    remark: str | None = None
    next_follow_at: datetime | None = None
    converted_to_customer_id: int | None = None
    converted_at: datetime | None = None
    created_by: str | None = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class LeadListResponse(BaseModel):
    items: list[LeadItem]
    total: int
    page: int
    page_size: int


class ConvertLeadRequest(BaseModel):
    # 可选：转化时覆盖客户字段；缺省用线索字段推断
    name: str | None = None
    rating: str | None = None
    source: str | None = None
    remark: str | None = None


class ConvertLeadResponse(BaseModel):
    lead: LeadItem
    customer: CustomerItem


# ---------- Opportunity ----------
class OpportunityCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    customer_id: int | None = None
    amount: float = 0
    stage: str = "lead_in"
    owner_id: str | None = None
    expected_close_date: str | None = None
    probability: int | None = Field(default=None, ge=0, le=100)
    remark: str | None = None


class OpportunityUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    customer_id: int | None = None
    amount: float | None = None
    stage: str | None = None
    owner_id: str | None = None
    expected_close_date: str | None = None
    probability: int | None = Field(default=None, ge=0, le=100)
    remark: str | None = None


class OpportunityItem(BaseModel):
    id: int
    name: str
    customer_id: int | None = None
    customer_name: str | None = None
    amount: float
    stage: str
    owner_id: str | None = None
    owner_name: str | None = None
    expected_close_date: str | None = None
    probability: int | None = None
    linked_project_id: int | None = None
    remark: str | None = None
    created_by: str | None = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class OpportunityListResponse(BaseModel):
    items: list[OpportunityItem]
    total: int
    page: int
    page_size: int


# ---------- Follow ----------
class FollowCreate(BaseModel):
    entity_type: Literal["customer", "lead", "opportunity"]
    entity_id: int
    type: str = "note"
    content: str = Field(min_length=1)
    next_follow_at: datetime | None = None


class FollowItem(BaseModel):
    id: int
    entity_type: str
    entity_id: int
    type: str
    content: str
    next_follow_at: datetime | None = None
    created_by: str | None = None
    created_by_name: str | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


# ---------- Follow-up 待跟进视图（P2b） ----------
class FollowUpItem(BaseModel):
    """一条待跟进记录（客户或线索），按 next_follow_at 归入逾期/今日/本周。"""

    entity_type: Literal["customer", "lead"]
    entity_id: int
    name: str
    subtitle: str | None = None  # 线索=公司名；客户=行业
    owner_id: str | None = None
    owner_name: str | None = None
    next_follow_at: datetime
    last_follow_content: str | None = None
    last_follow_at: datetime | None = None
    rating: str | None = None  # 客户等级
    status: str | None = None  # 客户状态 / 线索状态
    intent: str | None = None  # 线索意向


class FollowUpGroups(BaseModel):
    overdue: list[FollowUpItem] = []
    today: list[FollowUpItem] = []
    this_week: list[FollowUpItem] = []
    overdue_count: int = 0
    total_count: int = 0


# ---------- User (crm-user-select 数据源) ----------
class CrmUserItem(BaseModel):
    id: str
    name: str
    email: str
    role_type: str | None = None
    is_active: bool = True


# ---------- 批量操作 ----------
class BatchTransferRequest(BaseModel):
    ids: list[int] = Field(min_length=1)
    to_owner_id: str


class BatchIdsRequest(BaseModel):
    ids: list[int] = Field(min_length=1)


# ---------- 数据看板（P3c，仅管理员） ----------
class NewThisMonth(BaseModel):
    """本月新增（Asia/Shanghai 口径）。"""

    new_customers: int = 0  # 本月新建客户数
    new_leads: int = 0  # 本月新建线索数
    converted_count: int = 0  # 本月转化数（converted_at 落本月）


class FollowActivity(BaseModel):
    """跟进活跃度。"""

    follow_count_7d: int = 0  # 最近 7 天跟进记录数


class OwnerPerformance(BaseModel):
    """每销售业绩（按负责人分组）。"""

    owner_id: str
    owner_name: str | None = None
    customer_count: int = 0  # 名下客户数（未删除）
    converted_this_month: int = 0  # 名下本月转化线索数


class DashboardStats(BaseModel):
    """CRM 数据看板聚合结果。"""

    lead_funnel: dict[
        str, int
    ] = {}  # 线索各状态计数（new/contacting/qualified/converted/discarded）
    new_this_month: NewThisMonth = Field(default_factory=NewThisMonth)
    follow_activity: FollowActivity = Field(default_factory=FollowActivity)
    per_owner: list[OwnerPerformance] = []


# ---------- Audit Log (P4) ----------
class AuditLogItem(BaseModel):
    id: int
    entity_type: str
    entity_id: int
    action: str
    actor_id: str | None = None
    actor_name: str | None = None
    summary: str | None = None
    created_at: datetime


class AuditLogListResponse(BaseModel):
    items: list[AuditLogItem]
    total: int
    page: int
    page_size: int
