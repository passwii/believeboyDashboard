"""流程模板管理 API 契约（BLF-1237 / P2）。

全部端点仅管理员可用（endpoint 层 ``require_admin``）。
模板节点正文（说明/工期/多条内容/附件）只在这些管理员端点上出现；
P1 的 ``GET /project-workflows/templates`` 仍然只下发 ``key/kind/title`` 元数据。
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.project_workflow import (
    ProjectWorkflowTaskAttachmentItem,
    ProjectWorkflowTaskContentItem,
    WorkflowKind,
)

TemplateOrigin = Literal["upload", "template"]


class WorkflowTemplateListItem(BaseModel):
    id: int
    key: str
    kind: WorkflowKind
    title: str
    description: str | None = None
    sort_order: int
    task_count: int


class WorkflowTemplateTaskItem(BaseModel):
    id: int
    template_id: int
    title: str
    description: str | None = None
    sort_order: int
    attachment_key: str | None = None
    duration_days: int | None = None
    contents: list[ProjectWorkflowTaskContentItem] = Field(default_factory=list)
    attachments: list[ProjectWorkflowTaskAttachmentItem] = Field(default_factory=list)


class WorkflowTemplateDetail(WorkflowTemplateListItem):
    tasks: list[WorkflowTemplateTaskItem] = Field(default_factory=list)


class WorkflowTemplateListResponse(BaseModel):
    templates: list[WorkflowTemplateListItem]


class WorkflowTemplateCreate(BaseModel):
    kind: WorkflowKind
    title: str = Field(min_length=1, max_length=160)
    description: str | None = None
    # 缺省时按标题自动生成（可读前缀 + 短随机后缀）。
    key: str | None = Field(default=None, max_length=80)
    sort_order: int | None = Field(default=None, ge=0)


class WorkflowTemplateUpdate(BaseModel):
    title: str | None = Field(default=None, max_length=160)
    description: str | None = None
    sort_order: int | None = Field(default=None, ge=0)


class WorkflowTemplateCopy(BaseModel):
    title: str | None = Field(default=None, max_length=160)
    key: str | None = Field(default=None, max_length=80)


class WorkflowTemplateTaskCreate(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    description: str | None = None
    attachment_key: str | None = Field(default=None, max_length=64)
    duration_days: int | None = Field(default=None, ge=0, le=3650)
    sort_order: int | None = Field(default=None, ge=0)


class WorkflowTemplateTaskUpdate(BaseModel):
    title: str | None = Field(default=None, max_length=160)
    description: str | None = None
    attachment_key: str | None = Field(default=None, max_length=64)
    duration_days: int | None = Field(default=None, ge=0, le=3650)


class WorkflowTemplateTaskOrderUpdate(BaseModel):
    task_ids: list[int] = Field(min_length=1)


class WorkflowTemplateContentCreate(BaseModel):
    body: str = Field(min_length=1)
    title: str | None = Field(default=None, max_length=160)
    sort_order: int | None = Field(default=None, ge=0)


class WorkflowTemplateContentUpdate(BaseModel):
    body: str | None = None
    title: str | None = Field(default=None, max_length=160)


__all__ = [
    "TemplateOrigin",
    "WorkflowTemplateListItem",
    "WorkflowTemplateTaskItem",
    "WorkflowTemplateDetail",
    "WorkflowTemplateListResponse",
    "WorkflowTemplateCreate",
    "WorkflowTemplateUpdate",
    "WorkflowTemplateCopy",
    "WorkflowTemplateTaskCreate",
    "WorkflowTemplateTaskUpdate",
    "WorkflowTemplateTaskOrderUpdate",
    "WorkflowTemplateContentCreate",
    "WorkflowTemplateContentUpdate",
    "date",
    "datetime",
]
