"""项目启动台流程 API 契约（BLF-1234）。

字段名与合同保持一致（前端直接消费 snake_case）。
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

WorkflowKind = Literal["store_launch", "product_development"]
WorkflowTaskStatus = Literal[
    "not_started", "in_progress", "waiting_on_partner", "completed"
]


class ProjectWorkflowTemplateOption(BaseModel):
    key: str
    kind: WorkflowKind
    title: str


class ProjectWorkflowTemplatesResponse(BaseModel):
    templates: list[ProjectWorkflowTemplateOption]


class ProjectWorkflowTaskItem(BaseModel):
    id: int
    workflow_id: int
    title: str
    description: str | None = None
    sort_order: int
    status: WorkflowTaskStatus
    attachment_key: str | None = None


class ProjectWorkflowItem(BaseModel):
    id: int
    project_id: int
    kind: WorkflowKind
    title: str
    template_key: str
    status: WorkflowTaskStatus
    task_count: int
    completed_task_count: int
    tasks: list[ProjectWorkflowTaskItem] = Field(default_factory=list)


class ProjectWorkflowListResponse(BaseModel):
    project_id: int
    workflows: list[ProjectWorkflowItem]


class ProjectWorkflowCreate(BaseModel):
    kind: WorkflowKind
    template_key: str = Field(min_length=1, max_length=80)
    title: str | None = Field(default=None, max_length=160)


class ProjectWorkflowTaskUpdate(BaseModel):
    status: WorkflowTaskStatus


class ProjectWorkflowSummaryWorkflow(BaseModel):
    id: int
    kind: WorkflowKind
    title: str
    template_key: str
    status: WorkflowTaskStatus
    completed_task_count: int
    task_count: int


class ProjectWorkflowSummaryItem(BaseModel):
    project_id: int
    workflows: list[ProjectWorkflowSummaryWorkflow]


class ProjectWorkflowSummaryResponse(BaseModel):
    projects: list[ProjectWorkflowSummaryItem]
