"""
Agent 操作日志（operation_audit_logs 的 agent 写操作子集）Schema（BLF-460）。

写操作明细上架：查询 ``operation_audit_logs`` 中 ``agent_id IS NOT NULL`` 的行，
复用写路由已落的 ``before_json / after_json``（如货件状态 in_transit → complete）。
``project_id`` 由 ``request_path``（正则）派生，兜底 ``before/after_json`` 内嵌值；
``operation_type`` 由 ``action`` 前缀派生（对齐读侧 ``operation_type`` 取值）。
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class AgentOperationLogItem(BaseModel):
    id: int
    created_at: str
    agent_id: str | None = None
    # Agent 中文显示名（BLF-471）：写操作落库时随行快照，未填回退显示 agent_id。
    agent_name: str | None = None
    action: str
    target_type: str
    target_id: str | None = None
    # 人类可读对象标识（BLF-471）：货件域派生 shipment_no（如 SH-2026-01），
    # 兜底 before/after 内嵌 shipment_no；无则 None（前端回退 #target_id）。
    target_label: str | None = None
    result: str
    project_id: int | None = None
    # 请求涉及的项目名（BLF-471）：由 project_id 查 projects 表还原，运营可读。
    project_name: str | None = None
    operation_type: str | None = None
    request_path: str | None = None
    request_method: str | None = None
    before_json: dict | list | None = None
    after_json: dict | list | None = None
    idempotency_key: str | None = None
    error_message: str | None = None


class AgentOperationLogsResponse(BaseModel):
    items: list[AgentOperationLogItem] = Field(default_factory=list)
    total: int
    page: int
    page_size: int
    has_next: bool


class AgentOperationLogSummaryItem(BaseModel):
    agent_id: str
    agent_name: str | None = None
    count: int


class AgentOperationLogActionSummaryItem(BaseModel):
    action: str
    count: int


class AgentOperationLogsSummaryResponse(BaseModel):
    total: int
    success_count: int
    failure_count: int
    unique_agent_count: int
    top_agents: list[AgentOperationLogSummaryItem] = Field(default_factory=list)
    top_actions: list[AgentOperationLogActionSummaryItem] = Field(default_factory=list)
