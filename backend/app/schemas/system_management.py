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


class UpsertCommissionRecordsRequest(BaseModel):
    report_month: str = Field(min_length=7, max_length=7)
    items: list[CommissionRecordUpsertItem] = Field(default_factory=list)


class CommissionRecordItem(BaseModel):
    id: int
    report_month: str
    project_id: int
    project_name: str
    person_name: str
    income_category: CommissionIncomeCategory
    income_total_usd: float
    factory_commission_rate: float
    public_commission_ratio: float
    commission_amount_usd: float
    usd_to_rmb_rate: float
    commission_amount_rmb: float
    payment_status: CommissionPaymentStatus
    payment_confirmed_at: str | None = None
    payment_confirmed_by: str | None = None
    computed_at: str
    updated_at: str


class CommissionRecordsResponse(BaseModel):
    report_month: str
    items: list[CommissionRecordItem] = Field(default_factory=list)


class UpdateCommissionPaymentStatusRequest(BaseModel):
    payment_status: CommissionPaymentStatus


class UpdateCommissionPaymentStatusResponse(BaseModel):
    item: CommissionRecordItem
