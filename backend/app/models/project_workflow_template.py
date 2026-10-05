"""流程模板模型（BLF-1237 / P2）。

P1 的模板是后端硬编码常量（``project_workflow_templates.py``）；P2 起模板与节点
改为**数据库持久化数据**，管理员可增删改排序、可复制：

- :class:`WorkflowTemplate`：模板（``key`` 稳定且唯一，``kind`` 与 P1 同口径）。
- :class:`WorkflowTemplateTask`：模板节点（标题/说明/顺序/固定文档键/计划工期）。
- :class:`WorkflowTemplateTaskContent`：模板节点的**一条内容**（一个节点可有多条）。
- :class:`WorkflowTemplateTaskAttachment`：模板节点的附件（R2 对象，可多个）。

模板是蓝图：项目创建流程时把节点、内容、附件**复制成快照**，
此后修改模板不回写已有项目（与 P1 快照语义一致）。
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base

TEMPLATE_KINDS = ("store_launch", "product_development")

_KIND_CHECK = "kind IN ('store_launch', 'product_development')"


class WorkflowTemplate(Base):
    """A reusable workflow blueprint maintained by administrators."""

    __tablename__ = "workflow_templates"
    __table_args__ = (
        UniqueConstraint("key", name="uq_workflow_templates_key"),
        CheckConstraint(_KIND_CHECK, name="workflow_templates_kind_check"),
        Index("ix_workflow_templates_kind_sort", "kind", "sort_order"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # 稳定键：project_workflows.template_key 以字符串引用它，创建后不可修改。
    key: Mapped[str] = mapped_column(String(80), nullable=False)
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    title: Mapped[str] = mapped_column(String(160), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
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

    tasks: Mapped[list["WorkflowTemplateTask"]] = relationship(
        back_populates="template",
        cascade="all, delete-orphan",
        order_by="WorkflowTemplateTask.sort_order",
        passive_deletes=True,
    )


class WorkflowTemplateTask(Base):
    """One ordered node inside a template."""

    __tablename__ = "workflow_template_tasks"
    __table_args__ = (
        Index("ix_workflow_template_tasks_template_sort", "template_id", "sort_order"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    template_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("workflow_templates.id", ondelete="CASCADE"),
        nullable=False,
    )
    title: Mapped[str] = mapped_column(String(160), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # P1 兼容：固定白名单文档键（两份内置资料），可空。
    attachment_key: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # 计划工期（天）；项目创建时复制为项目节点的计划工期，用于推算阶段日期。
    duration_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    template: Mapped[WorkflowTemplate] = relationship(back_populates="tasks")
    contents: Mapped[list["WorkflowTemplateTaskContent"]] = relationship(
        back_populates="task",
        cascade="all, delete-orphan",
        order_by="WorkflowTemplateTaskContent.sort_order",
        passive_deletes=True,
    )
    attachments: Mapped[list["WorkflowTemplateTaskAttachment"]] = relationship(
        back_populates="task",
        cascade="all, delete-orphan",
        order_by="WorkflowTemplateTaskAttachment.id",
        passive_deletes=True,
    )


class WorkflowTemplateTaskContent(Base):
    """A single content block of a template node (nodes may hold several)."""

    __tablename__ = "workflow_template_task_contents"
    __table_args__ = (
        Index(
            "ix_workflow_template_task_contents_task_sort", "template_task_id", "sort_order"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    template_task_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("workflow_template_tasks.id", ondelete="CASCADE"),
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

    task: Mapped[WorkflowTemplateTask] = relationship(back_populates="contents")


class WorkflowTemplateTaskAttachment(Base):
    """An R2-backed file attached to a template node."""

    __tablename__ = "workflow_template_task_attachments"
    __table_args__ = (
        Index(
            "ix_workflow_template_task_attachments_task", "template_task_id"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    template_task_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("workflow_template_tasks.id", ondelete="CASCADE"),
        nullable=False,
    )
    # 受控 R2 key（服务端生成，绝不由用户输入拼接）。
    # 列名不以 _r2_key 结尾，需登记进 ArtifactService._IRREGULAR_KEY_COLUMNS，
    # 否则 cleanup_r2_orphaned_files.py 会把它当孤儿文件删除。
    r2_key: Mapped[str] = mapped_column(String(512), nullable=False)
    filename: Mapped[str] = mapped_column(String(256), nullable=False)
    content_type: Mapped[str] = mapped_column(String(128), nullable=False)
    file_size: Mapped[int] = mapped_column(Integer, nullable=False)
    uploader: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    task: Mapped[WorkflowTemplateTask] = relationship(back_populates="attachments")
