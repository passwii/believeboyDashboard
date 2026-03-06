from enum import Enum

from pydantic import BaseModel, Field


class DataLifecycleStatus(str, Enum):
    active = 'active'
    maintenance = 'maintenance'
    read_only = 'read_only'
    paused = 'paused'


class TableHealthStatus(str, Enum):
    healthy = 'healthy'
    empty = 'empty'
    stale = 'stale'
    error = 'error'


class DatabaseStatus(BaseModel):
    engine: str
    source: str | None = None
    healthy: bool
    checked_at: str


class DataManagementStatusResponse(BaseModel):
    server_time: str
    database: DatabaseStatus
    cache_enabled: bool


class DataSummary(BaseModel):
    total_tables: int
    total_rows: int
    stale_tables: int
    data_status: DataLifecycleStatus


class TableStatusItem(BaseModel):
    table_name: str
    row_count: int | None = None
    last_updated_at: str | None = None
    status: TableHealthStatus
    note: str | None = None


class RecentSystemStatusItem(BaseModel):
    source: str
    level: str
    message: str
    occurred_at: str


class DataManagementOverviewResponse(BaseModel):
    server_time: str
    database: DatabaseStatus
    cache_enabled: bool
    summary: DataSummary
    data_status_note: str | None = None
    data_status_updated_at: str | None = None
    data_status_updated_by: str | None = None
    tables: list[TableStatusItem] = Field(default_factory=list)
    recent_statuses: list[RecentSystemStatusItem] = Field(default_factory=list)


class UpdateDataStatusRequest(BaseModel):
    status: DataLifecycleStatus
    note: str | None = Field(default=None, max_length=500)


class UpdateDataStatusResponse(BaseModel):
    status: DataLifecycleStatus
    note: str | None = None
    updated_at: str
    updated_by: str | None = None


class CommissionIncomeCategory(str, Enum):
    operator = 'operator'
    assistant = 'assistant'


class CommissionPaymentStatus(str, Enum):
    paid = 'paid'
    unpaid = 'unpaid'


class CommissionProjectPaymentStatus(str, Enum):
    paid = 'paid'
    partial = 'partial'
    unpaid = 'unpaid'


class CommissionRatioSource(str, Enum):
    rule = 'rule'
    manual = 'manual'


class CommissionRecordUpsertItem(BaseModel):
    project_id: int = Field(gt=0)
    project_name: str = Field(min_length=1, max_length=255)
    person_name: str = Field(min_length=1, max_length=255)
    income_category: CommissionIncomeCategory
    income_total_usd: float = Field(ge=0)
    factory_commission_rate: float = Field(ge=0, le=1)
    public_commission_ratio: float = Field(ge=0, le=1)
    commission_amount_usd: float = Field(ge=0)
    usd_to_rmb_rate: float = Field(ge=0)
    commission_amount_rmb: float = Field(ge=0)
    ratio_source: CommissionRatioSource = CommissionRatioSource.rule
    manual_ratio: float | None = Field(default=None, ge=0, le=1)


class UpsertCommissionRecordsRequest(BaseModel):
    report_month: str = Field(min_length=7, max_length=7)
    items: list[CommissionRecordUpsertItem] = Field(default_factory=list)


class CommissionRecordItem(BaseModel):
    id: int
    report_month: str
    project_id: int
    project_name: str
    project_month_id: int | None = None
    person_name: str
    income_category: CommissionIncomeCategory
    income_total_usd: float
    factory_commission_rate: float
    public_commission_ratio: float
    commission_amount_usd: float
    usd_to_rmb_rate: float
    commission_amount_rmb: float
    ratio_source: CommissionRatioSource
    manual_ratio: float | None = None
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


class CommissionProjectMonthItem(BaseModel):
    id: int
    report_month: str
    project_id: int
    project_name: str
    income_total_usd: float
    factory_commission_rate: float
    usd_to_rmb_rate: float
    factory_commission_usd: float
    factory_commission_rmb: float
    payment_status: CommissionProjectPaymentStatus
    received_rmb: float
    payment_confirmed_at: str | None = None
    payment_confirmed_by: str | None = None
    note: str | None = None
    computed_at: str
    updated_at: str


class CommissionProjectMonthsResponse(BaseModel):
    report_month: str
    items: list[CommissionProjectMonthItem] = Field(default_factory=list)


class CommissionYearlyMonthlySummaryItem(BaseModel):
    report_month: str
    income_total_usd: float
    factory_commission_usd: float
    factory_commission_rmb: float
    received_rmb: float
    receive_rate: float


class CommissionYearlyMonthlySummaryResponse(BaseModel):
    year: str
    items: list[CommissionYearlyMonthlySummaryItem] = Field(default_factory=list)


class CommissionProjectMonthlySummaryMonthItem(BaseModel):
    report_month: str
    income_total_usd: float
    factory_commission_rmb: float
    received_rmb: float
    receive_rate: float


class CommissionProjectYearlySummaryItem(BaseModel):
    project_id: int
    project_name: str
    months: dict[str, CommissionProjectMonthlySummaryMonthItem] = Field(default_factory=dict)
    total_income_usd: float
    total_commission_rmb: float
    total_received_rmb: float
    receive_rate: float


class CommissionProjectYearlySummaryResponse(BaseModel):
    year: str
    items: list[CommissionProjectYearlySummaryItem] = Field(default_factory=list)


class UpdateCommissionProjectPaymentRequest(BaseModel):
    payment_status: CommissionProjectPaymentStatus
    received_rmb: float = Field(ge=0)
    note: str | None = Field(default=None, max_length=500)


class UpdateCommissionProjectPaymentResponse(BaseModel):
    item: CommissionProjectMonthItem


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


class ProjectRoleAssignmentItem(BaseModel):
    id: int
    project_id: int
    role_type: CommissionIncomeCategory
    person_name: str
    effective_from_month: str
    effective_to_month: str | None = None
    updated_at: str


class UpsertProjectRoleAssignmentItem(BaseModel):
    id: int | None = None
    project_id: int = Field(gt=0)
    role_type: CommissionIncomeCategory
    person_name: str = Field(min_length=1, max_length=255)
    effective_from_month: str = Field(min_length=7, max_length=7)
    effective_to_month: str | None = Field(default=None, min_length=7, max_length=7)


class UpsertProjectRoleAssignmentsRequest(BaseModel):
    items: list[UpsertProjectRoleAssignmentItem] = Field(default_factory=list)


class ProjectRoleAssignmentsResponse(BaseModel):
    items: list[ProjectRoleAssignmentItem] = Field(default_factory=list)


class OperationAuditLogItem(BaseModel):
    id: int
    created_at: str
    operator: str | None = None
    action: str
    target_type: str
    target_id: str | None = None
    result: str
    trace_id: str | None = None
    request_method: str | None = None
    request_path: str | None = None
    ip_address: str | None = None
    user_agent: str | None = None
    before_json: dict | list | None = None
    after_json: dict | list | None = None
    error_message: str | None = None


class OperationAuditLogsResponse(BaseModel):
    items: list[OperationAuditLogItem] = Field(default_factory=list)
    total: int
    page: int
    page_size: int
    has_next: bool
