"""项目启动台所需的流程实例与任务快照模型（BLF-1234）。

一个项目最多一条「店铺启动」流程（``kind='store_launch'``），
可以有多条「产品开发」流程（``kind='product_development'``，每个产品实例一条）。
任务标题/描述/附件键在创建流程时从后端模板**复制**成快照，
后续模板文案调整不会回写已有项目进度（见 service 层 ``create_workflow``）。

P2（BLF-1237）在同一张表上追加排期与多内容字段：
- ``ProjectWorkflow.start_date``：流程排期锚点（管理员维护）。
- ``ProjectWorkflowTask.duration_days`` / ``start_date`` / ``end_date``：阶段工期与起止日期。
- :class:`ProjectWorkflowTaskContent`：节点的一条内容（可多条）。
- :class:`ProjectWorkflowTaskAttachment`：节点附件（R2，可多个）。
"""

from __future__ import annotations

from datetime import date, datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base

if TYPE_CHECKING:
    from app.models.project import Project

WORKFLOW_KINDS = ("store_launch", "product_development")
WORKFLOW_TASK_STATUSES = (
    "not_started",
    "in_progress",
    "waiting_on_partner",
    "completed",
)

_KIND_CHECK = "kind IN ('store_launch', 'product_development')"
_STATUS_CHECK = (
    "status IN ('not_started', 'in_progress', 'waiting_on_partner', 'completed')"
)


class ProjectWorkflow(Base):
    """A workflow instance bound to one project (startup or product development)."""

    __tablename__ = "project_workflows"
    __table_args__ = (
        CheckConstraint(_KIND_CHECK, name="project_workflows_kind_check"),
        Index("ix_project_workflows_project_kind", "project_id", "kind"),
        # 单项目唯一：店铺启动只允许一条；产品开发不在此约束内（可以多条）。
        Index(
            "uq_project_workflows_store_launch_project_id",
            "project_id",
            unique=True,
            postgresql_where=text("kind = 'store_launch'"),
            sqlite_where=text("kind = 'store_launch'"),
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
    )
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    title: Mapped[str] = mapped_column(String(160), nullable=False)
    template_key: Mapped[str] = mapped_column(String(80), nullable=False)
    # 排期锚点：节点未手填日期时，按工期从这里顺序推算（P2）。
    start_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    project: Mapped["Project"] = relationship()
    tasks: Mapped[list["ProjectWorkflowTask"]] = relationship(
        back_populates="workflow",
        cascade="all, delete-orphan",
        order_by="ProjectWorkflowTask.sort_order",
        passive_deletes=True,
    )


class ProjectWorkflowTask(Base):
    """One ordered task snapshot inside a workflow instance."""

    __tablename__ = "project_workflow_tasks"
    __table_args__ = (
        CheckConstraint(_STATUS_CHECK, name="project_workflow_tasks_status_check"),
        Index("ix_project_workflow_tasks_workflow_sort", "workflow_id", "sort_order"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    workflow_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("project_workflows.id", ondelete="CASCADE"),
        nullable=False,
    )
    title: Mapped[str] = mapped_column(String(160), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    status: Mapped[str] = mapped_column(
        String(32), nullable=False, default="not_started", server_default="not_started"
    )
    attachment_key: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # 阶段计划工期（天），创建流程时从模板复制（P2）。
    duration_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # 阶段起止日期：管理员可手填；未手填时按工期与流程锚点推算（P2）。
    start_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    end_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    workflow: Mapped[ProjectWorkflow] = relationship(back_populates="tasks")
    contents: Mapped[list["ProjectWorkflowTaskContent"]] = relationship(
        back_populates="task",
        cascade="all, delete-orphan",
        order_by="ProjectWorkflowTaskContent.sort_order",
        passive_deletes=True,
    )
    attachments: Mapped[list["ProjectWorkflowTaskAttachment"]] = relationship(
        back_populates="task",
        cascade="all, delete-orphan",
        order_by="ProjectWorkflowTaskAttachment.id",
        passive_deletes=True,
    )


class ProjectWorkflowTaskContent(Base):
    """A single content block of a project node (nodes may hold several)."""

    __tablename__ = "project_workflow_task_contents"
    __table_args__ = (
        Index(
            "ix_project_workflow_task_contents_task_sort",
            "task_id",
            "sort_order",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    task_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("project_workflow_tasks.id", ondelete="CASCADE"),
        nullable=False,
    )
    title: Mapped[str | None] = mapped_column(String(160), nullable=True)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    task: Mapped[ProjectWorkflowTask] = relationship(back_populates="contents")


class ProjectWorkflowTaskAttachment(Base):
    """An R2-backed internal file attached to a project node."""

    __tablename__ = "project_workflow_task_attachments"
    __table_args__ = (
        CheckConstraint(
            "origin IN ('upload', 'template')",
            name="project_workflow_task_attachments_origin_check",
        ),
        Index("ix_project_workflow_task_attachments_task", "task_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    task_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("project_workflow_tasks.id", ondelete="CASCADE"),
        nullable=False,
    )
    # 受控 R2 key（服务端生成）。需登记进 ArtifactService._IRREGULAR_KEY_COLUMNS。
    r2_key: Mapped[str] = mapped_column(String(512), nullable=False)
    filename: Mapped[str] = mapped_column(String(256), nullable=False)
    content_type: Mapped[str] = mapped_column(String(128), nullable=False)
    file_size: Mapped[int] = mapped_column(Integer, nullable=False)
    uploader: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # upload（项目内上传）/ template（由模板附件复制而来，共享同一个 R2 对象）。
    origin: Mapped[str] = mapped_column(
        String(16), nullable=False, default="upload", server_default="upload"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    task: Mapped[ProjectWorkflowTask] = relationship(back_populates="attachments")
