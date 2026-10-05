"""项目启动台所需的流程实例与任务快照模型（BLF-1234）。

一个项目最多一条「店铺启动」流程（``kind='store_launch'``），
可以有多条「产品开发」流程（``kind='product_development'``，每个产品实例一条）。
任务标题/描述/附件键在创建流程时从后端模板**复制**成快照，
后续模板文案调整不会回写已有项目进度（见 service 层 ``create_workflow``）。
"""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
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
