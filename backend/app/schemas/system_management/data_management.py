"""
数据管理相关 Schema。
"""
from enum import Enum

from pydantic import BaseModel, Field


class DataLifecycleStatus(str, Enum):
    active = "active"
    maintenance = "maintenance"
    read_only = "read_only"
    paused = "paused"


class TableHealthStatus(str, Enum):
    healthy = "healthy"
    empty = "empty"
    stale = "stale"
    error = "error"


class DatabaseStatus(BaseModel):
    engine: str
    source: str | None = None
    healthy: bool
    checked_at: str


class DataSummary(BaseModel):
    total_tables: int
    total_rows: int
    stale_tables: int
    data_status: DataLifecycleStatus


class DataManagementStatusResponse(BaseModel):
    server_time: str
    database: DatabaseStatus
    cache_enabled: bool
    summary: DataSummary
    data_status_note: str | None = None
    data_status_updated_at: str | None = None
    data_status_updated_by: str | None = None


class TableStatusItem(BaseModel):
    table_name: str
    table_name_cn: str | None = None
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


class ClearCacheResponse(BaseModel):
    deleted_count: int
    message: str