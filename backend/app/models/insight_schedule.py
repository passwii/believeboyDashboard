"""Insight Schedule Model — 定时生成 AI Insight 的调度配置"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class InsightSchedule(Base):
    """
    定时生成 AI Insight 的调度配置。
    
    每条记录定义了一个定时任务：何时执行、针对哪个项目、生成什么类型的洞察。
    APScheduler 根据 cron_expression 触发任务，调用 Celery 任务执行生成。
    """

    __tablename__ = "insight_schedules"
    __table_args__ = (
        Index("idx_schedule_active", "is_active"),
        Index("idx_schedule_project", "project_id"),
    )

    id: Mapped[int] = mapped_column(
        Integer, primary_key=True, autoincrement=True
    )

    # 关联项目和国家
    project_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    country: Mapped[str] = mapped_column(String(2), nullable=False, default="US")

    # 洞察类型：daily / weekly / monthly / custom
    insight_type: Mapped[str] = mapped_column(
        String(32), nullable=False, default="daily"
    )

    # Cron 表达式（标准 5 字段：分 时 日 月 周）
    # 例如: "0 7 * * *" 表示每天 07:00
    cron_expression: Mapped[str] = mapped_column(String(64), nullable=False)

    # 日期范围策略：yesterday / last_7d / last_30d / prev_month / current_month / last_week
    # 定义生成洞察时所分析的数据时间范围
    date_range_strategy: Mapped[str] = mapped_column(
        String(32), nullable=False, default="yesterday"
    )

    # 可选的 LLM 模型覆盖（默认使用配置中的 basic 模型）
    model: Mapped[str | None] = mapped_column(String(64), nullable=True)

    # 启用状态
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    # 创建信息
    created_by: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    # 执行统计
    last_run_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_insight_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)

    # 累计执行次数
    run_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    failure_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    # 下次执行时间（由 APScheduler 维护）
    next_run_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )