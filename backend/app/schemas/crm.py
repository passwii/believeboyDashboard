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
    entered_stage_at: datetime | None = None  # P8 (BLF-517): 进入当前阶段时间戳
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


# ---------- 漏斗指标（P8, BLF-517） ----------
class FunnelDimensionItem(BaseModel):
    """按某维度聚合的一段漏斗：key=维度键，label=展示名（owner 姓名 / source / 月份）。

    funnel 永远是该 key 下 5 状态计数（new/contacting/qualified/converted/discarded），
    顺序与 _LEAD_STATUS_ORDER 一致（dict 顺序即展示顺序）。
    """

    key: str
    label: str | None = None
    funnel: dict[str, int] = {}


class FunnelMetrics(BaseModel):
    """按 时间/角色/来源 聚合的漏斗数据（P8, BLF-517）。

    - total：全部线索 5 状态快照（应用了 owner/source 过滤；time 过滤时按
      entered_stage_at ∈ [start_at, end_at) 计，未给时间范围则按当前状态快照）。
    - items：按 dimension 拆分（owner / source / time 分桶）。
      dimension=time 时基于 entered_stage_at（新字段，历史数据 NULL 不计入分桶，
      但计入 total 快照——这是「本期流入动态」与「当前存量」的差异，属预期）。
    """

    dimension: Literal["owner", "source", "time"]
    total: dict[str, int] = {}
    items: list[FunnelDimensionItem] = []
    start_at: datetime | None = None
    end_at: datetime | None = None


class StageLeadItem(BaseModel):
    """阶段明细里的单条线索（漏斗二层复盘面板用）。

    dwell_days = (now - coalesce(entered_stage_at, updated_at)) 的天数；
    is_stuck = dwell_days > stuck_days（默认 7 天，与 P9 无跟进提醒阈值一致）。
    """

    id: int
    name: str
    company: str | None = None
    owner_id: str | None = None
    owner_name: str | None = None
    source: str | None = None
    intent: str | None = None
    entered_stage_at: datetime | None = None
    last_action_at: datetime | None = None  # = max(CrmFollow.created_at)，无跟进为 None
    last_action_content: str | None = None  # 最近一条跟进内容（面板展示，前端截断）
    next_follow_at: datetime | None = None
    dwell_days: float | None = None
    is_stuck: bool = False


class StageDetail(BaseModel):
    """某阶段的复盘明细（漏斗二层面板）。"""

    stage: str
    count: int = 0  # 当前处于该阶段的线索数（未删除）
    avg_dwell_days: float | None = None  # 平均停留天数（无数据为 None）
    stuck_count: int = 0  # 停留 > stuck_days 的条数
    inflow: int = (
        0  # 本期流入 = entered_stage_at ∈ period 的当前成员数；无 period = 全部成员
    )
    outflow: int | None = (
        None  # 本期流失（近似）：晋级后续阶段(entered_stage_at∈period) + 弃置(updated_at∈period)；无 period=None
    )
    stuck_days: int = 7
    leads: list[StageLeadItem] = []
    page: int = 1
    page_size: int = 50
    total: int = 0


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


# ---------- Task (P7, BLF-510) ----------
class TaskCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str | None = None
    due_date: datetime | None = None
    priority: Literal["low", "medium", "high", "urgent"] = "medium"
    type: Literal["follow_up", "call", "visit", "custom"] = "custom"
    owner_id: str | None = None  # 仅 admin 可指派他人；null=未指派
    customer_id: int | None = None
    lead_id: int | None = None


class TaskUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None
    due_date: datetime | None = None
    priority: Literal["low", "medium", "high", "urgent"] | None = None
    type: Literal["follow_up", "call", "visit", "custom"] | None = None
    owner_id: str | None = None  # 仅 admin 可改（非 admin 传 → 403）
    customer_id: int | None = None
    lead_id: int | None = None


class TaskItem(BaseModel):
    id: int
    title: str
    description: str | None = None
    due_date: datetime | None = None
    priority: str
    status: str
    type: str
    owner_id: str | None = None
    owner_name: str | None = None
    customer_id: int | None = None
    customer_name: str | None = None
    lead_id: int | None = None
    lead_name: str | None = None
    reminded_at: datetime | None = None
    created_by: str | None = None
    completed_at: datetime | None = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class TaskStatusUpdate(BaseModel):
    status: Literal["pending", "in_progress", "done"]


class TaskCompleteRequest(BaseModel):
    """完成任务表单（P7-6 §3.3 完成联动）。

    next_follow_at: 可选「下次跟进时间」；带值→回写实体，未填（None）→清空实体
    （与 follow_service.create_follow 语义一致）。
    note: 完成备注，追加到自动生成的 follow content（"任务标题：备注"）。
    """

    next_follow_at: datetime | None = None
    note: str | None = Field(default=None, max_length=1000)


class TaskListResponse(BaseModel):
    items: list[TaskItem]
    total: int
    page: int
    page_size: int
