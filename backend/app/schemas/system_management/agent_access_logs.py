"""
Agent 访问日志（agent_api_audit_log）Schema。

中间件每请求一行记录 /api/v1/agent/* 与 /api/v1/external/* 的访问；
管理端查询时 join agent_api_keys 还原 agent_id / label。
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class AgentAccessLogItem(BaseModel):
    id: int
    created_at: str
    method: str
    path: str
    status_code: int
    latency_ms: int
    ip_address: str | None = None
    api_key_id: int | None = None
    agent_id: str | None = None
    key_label: str | None = None
    # BLF-460 读操作明细：请求涉及的项目 ID 与业务域（中间件从 path 解析）。
    project_id: int | None = None
    operation_type: str | None = None


class AgentAccessLogsResponse(BaseModel):
    items: list[AgentAccessLogItem] = Field(default_factory=list)
    total: int
    page: int
    page_size: int
    has_next: bool


class AgentAccessLogAgentSummaryItem(BaseModel):
    agent_id: str
    key_label: str | None = None
    count: int


class AgentAccessLogsSummaryResponse(BaseModel):
    total: int
    success_count: int
    error_count: int
    unique_agent_count: int
    top_agents: list[AgentAccessLogAgentSummaryItem] = Field(default_factory=list)
