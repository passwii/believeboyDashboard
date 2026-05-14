"""
审计日志相关 Schema。
"""
from enum import Enum

from pydantic import BaseModel, Field


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


class OperationAuditLogModuleSummaryItem(BaseModel):
    key: str
    label: str
    count: int
    success_count: int
    failure_count: int


class OperationAuditLogActionSummaryItem(BaseModel):
    action: str
    count: int


class OperationAuditLogsSummaryResponse(BaseModel):
    total: int
    success_count: int
    failure_count: int
    unique_operator_count: int
    modules: list[OperationAuditLogModuleSummaryItem] = Field(default_factory=list)
    top_actions: list[OperationAuditLogActionSummaryItem] = Field(default_factory=list)