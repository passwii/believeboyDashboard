"""项目启动台流程 API 契约（BLF-1234 / P2 BLF-1237）。

字段名与合同保持一致（前端直接消费 snake_case）。
P2 追加的字段都是**附加**的：P1 的字段一个都没删、没改名。
"""

from __future__ import annotations

from datetime import date, datetime
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


class ProjectWorkflowTaskContentItem(BaseModel):
    id: int
    title: str | None = None
    body: str
    sort_order: int


class ProjectWorkflowTaskAttachmentItem(BaseModel):
    id: int
    filename: str
    content_type: str
    file_size: int
    uploader: str | None = None
    created_at: datetime
    # 仅项目侧返回：upload（项目内上传）/ template（模板附件副本，共享 R2 对象）。
    origin: Literal["upload", "template"] | None = None


class ProjectWorkflowTaskItem(BaseModel):
    id: int
    workflow_id: int
    title: str
    description: str | None = None
    sort_order: int
    status: WorkflowTaskStatus
    attachment_key: str | None = None
    # P2：阶段排期与多条内容/附件
    duration_days: int | None = None
    start_date: date | None = None
    end_date: date | None = None
    span_days: int | None = None
    contents: list[ProjectWorkflowTaskContentItem] = Field(default_factory=list)
    attachments: list[ProjectWorkflowTaskAttachmentItem] = Field(default_factory=list)


class ProjectWorkflowItem(BaseModel):
    id: int
    project_id: int
    kind: WorkflowKind
    title: str
    template_key: str
    status: WorkflowTaskStatus
    task_count: int
    completed_task_count: int
    # P2：流程排期锚点 + 由节点派生的起止与时长
    start_date: date | None = None
    schedule_start: date | None = None
    schedule_end: date | None = None
    schedule_days: int | None = None
    tasks: list[ProjectWorkflowTaskItem] = Field(default_factory=list)


class ProjectWorkflowListResponse(BaseModel):
    project_id: int
    workflows: list[ProjectWorkflowItem]


class ProjectWorkflowCreate(BaseModel):
    kind: WorkflowKind
    template_key: str = Field(min_length=1, max_length=80)
    title: str | None = Field(default=None, max_length=160)
    # P2：排期锚点，缺省时节点日期留空等管理员填。
    start_date: date | None = None


class ProjectWorkflowDefinitionUpdate(BaseModel):
    """流程定义（仅管理员）：改标题或排期锚点。"""

    title: str | None = Field(default=None, max_length=160)
    start_date: date | None = None


class ProjectWorkflowTaskUpdate(BaseModel):
    """P1 契约：**只接受状态**，非管理员可用。"""

    status: WorkflowTaskStatus


class ProjectWorkflowTaskCreate(BaseModel):
    """项目内新增节点（仅管理员）。"""

    title: str = Field(min_length=1, max_length=160)
    description: str | None = None
    attachment_key: str | None = Field(default=None, max_length=64)
    duration_days: int | None = Field(default=None, ge=0, le=3650)
    sort_order: int | None = Field(default=None, ge=0)


class ProjectWorkflowTaskDefinitionUpdate(BaseModel):
    """项目内节点定义（仅管理员）：不含 status。"""

    title: str | None = Field(default=None, max_length=160)
    description: str | None = None
    attachment_key: str | None = Field(default=None, max_length=64)
    duration_days: int | None = Field(default=None, ge=0, le=3650)
    start_date: date | None = None
    end_date: date | None = None


class ProjectWorkflowTaskOrderUpdate(BaseModel):
    task_ids: list[int] = Field(min_length=1)


class ProjectWorkflowContentCreate(BaseModel):
    body: str = Field(min_length=1)
    title: str | None = Field(default=None, max_length=160)
    sort_order: int | None = Field(default=None, ge=0)


class ProjectWorkflowContentUpdate(BaseModel):
    body: str | None = None
    title: str | None = Field(default=None, max_length=160)


class ProjectWorkflowSummaryWorkflow(BaseModel):
    id: int
    kind: WorkflowKind
    title: str
    template_key: str
    status: WorkflowTaskStatus
    completed_task_count: int
    task_count: int
    start_date: date | None = None
    schedule_start: date | None = None
    schedule_end: date | None = None
    schedule_days: int | None = None


class ProjectWorkflowSummaryItem(BaseModel):
    project_id: int
    workflows: list[ProjectWorkflowSummaryWorkflow]
    # P2：项目整体排期 = 所有流程节点日期的并集区间
    schedule_start: date | None = None
    schedule_end: date | None = None
    schedule_days: int | None = None


class ProjectWorkflowSummaryResponse(BaseModel):
    projects: list[ProjectWorkflowSummaryItem]
