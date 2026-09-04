"""Scheduled Report Subscription and Delivery Log Models."""

from __future__ import annotations

from datetime import datetime
from enum import Enum

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.sql import text

from app.db.session import Base


class ReportFrequency(str, Enum):
    DAILY = "daily"
    WEEKLY = "weekly"
    MONTHLY = "monthly"


class DeliveryStatus(str, Enum):
    PENDING = "pending"
    SENT = "sent"
    FAILED = "failed"
    SUPERSEDED = "superseded"  # 历史重复的派发行被新版唯一约束收敛；保留痕跡便于复盘


class DeliveryStage(str, Enum):
    PENDING = "pending"
    PREPARING = "preparing"
    FETCHING_DATA = "fetching_data"
    GENERATING_SUMMARY = "generating_summary"
    RENDERING_HTML = "rendering_html"
    CAPTURING_SCREENSHOT = "capturing_screenshot"
    SENDING = "sending"
    DONE = "done"
    FAILED = "failed"


class AiSummaryStatus(str, Enum):
    PENDING = "pending"
    GENERATING = "generating"
    DONE = "done"
    FAILED = "failed"


class LedgerStatus(str, Enum):
    SENT = "sent"
    FAILED = "failed"
    MISSING = "missing"


class ScheduledReportSubscription(Base):
    __tablename__ = "scheduled_report_subscriptions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    email: Mapped[str | None] = mapped_column(String(256), nullable=True, comment="接收邮箱；留空则不发送邮件，仅生成报告")
    project_ids: Mapped[str] = mapped_column(String(500), nullable=False, default="*")
    country: Mapped[str] = mapped_column(String(256), nullable=False, default="US")
    frequency: Mapped[str] = mapped_column(String(20), nullable=False)
    ai_model: Mapped[str | None] = mapped_column(String(64), nullable=True, comment="AI 摘要使用的模型，空则用默认模型")
    dispatch_hour: Mapped[int] = mapped_column(Integer, nullable=False, default=15, comment="发送时间（小时，0-23，北京时间）")
    dispatch_minute: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0,
        comment="发送时间（分钟，0-59）",
    )
    dispatch_weekday: Mapped[int | None] = mapped_column(
        Integer, nullable=True,
        comment="周报发送日（0=周一..6=周日），仅 weekly 使用",
    )
    dispatch_day: Mapped[int | None] = mapped_column(
        Integer, nullable=True,
        comment="月报发送日（2-28），仅 monthly 使用",
    )
    enabled: Mapped[bool] = mapped_column(nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False,
        server_default=func.now(), onupdate=func.now()
    )

    # Relationships
    delivery_logs: Mapped[list["ScheduledReportDeliveryLog"]] = relationship(
        "ScheduledReportDeliveryLog",
        back_populates="subscription",
        cascade="all, delete-orphan",
    )

    @property
    def project_id_list(self) -> list[int]:
        if self.project_ids == "*":
            return []
        try:
            return [int(x.strip()) for x in self.project_ids.split(",") if x.strip()]
        except ValueError:
            return []

    @property
    def country_list(self) -> list[str]:
        """Parse comma-separated country field into a list."""
        return [c.strip().upper() for c in self.country.split(",") if c.strip()]


class ScheduledReportDeliveryLog(Base):
    __tablename__ = "scheduled_report_delivery_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    subscription_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("scheduled_report_subscriptions.id", ondelete="CASCADE"), nullable=False
    )
    frequency: Mapped[str] = mapped_column(String(20), nullable=False)
    report_date: Mapped[str] = mapped_column(String(20), nullable=False)
    report_month: Mapped[str | None] = mapped_column(String(10), nullable=True)
    email: Mapped[str | None] = mapped_column(String(256), nullable=True, comment="订阅邮箱快照；订阅留空时为 NULL")
    triggered_by: Mapped[str] = mapped_column(
        String(20), nullable=False, default="auto",
        comment="auto=自动调度, manual=人工补发/重跑",
    )
    status: Mapped[str] = mapped_column(String(20), nullable=False, default=DeliveryStatus.PENDING.value)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    screenshot_r2_key: Mapped[str | None] = mapped_column(String(512), nullable=True, comment="R2 object key for screenshot")
    screenshot_r2_url: Mapped[str | None] = mapped_column(String(1024), nullable=True, comment="Public URL for screenshot")
    screenshot_r2_thumb_key: Mapped[str | None] = mapped_column(String(512), nullable=True, comment="R2 thumb object key for screenshot")
    screenshot_r2_thumb_url: Mapped[str | None] = mapped_column(String(1024), nullable=True, comment="Public URL for thumb")
    ai_summary: Mapped[str | None] = mapped_column(Text, nullable=True, comment="AI 报表总结文案（Markdown）")
    ai_summary_status: Mapped[str] = mapped_column(
        String(20), nullable=False, default=AiSummaryStatus.PENDING.value, index=True,
        comment="AI 摘要状态: pending/generating/done/failed",
    )
    ai_summary_error: Mapped[str | None] = mapped_column(Text, nullable=True, comment="AI 摘要生成错误")
    ai_summary_model: Mapped[str | None] = mapped_column(String(64), nullable=True, comment="AI 摘要使用模型")
    ai_summary_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    stage: Mapped[str] = mapped_column(
        String(20), nullable=False, default=DeliveryStage.PENDING.value, index=True,
        comment="处理阶段: pending/preparing/fetching_data/generating_summary/rendering_html/capturing_screenshot/sending/done/failed"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    # Relationships
    subscription: Mapped["ScheduledReportSubscription"] = relationship(
        "ScheduledReportSubscription", back_populates="delivery_logs"
    )

    # P0-3（收窄，产品决策 2026-07-13）：阻止 (sub, freq, report_date, triggered_by)
    # 重复派发。使用 **partial unique index** 而非全表 unique constraint，因为：
    #   1. 历史 119 行已 supersede（保留痕跡，但同组 2+ 行仍存在）；
    #   2. failed 状态行未来可能因人工重试需重跑——不应被 unique 卡住；
    #   3. partial index 只对未来 active 行 enforce unique——保护 INSERT 路径
    #      同时保留历史。
    # 收窄点：WHERE 加 `triggered_by = 'auto'`。auto 派发保留“一天一次”去重
    # （防 (30, daily, ..., auto) 自动双跑）；manual / 补发 完全不在唯一索引
    # 覆盖范围内，每天可任意重发（含失败 / 历史），永不撞 IntegrityError。
    # 同时给 SQLite 测试库同样的 partial WHERE，保证本地行为一致。
    __table_args__ = (
        Index(
            "uq_delivery_log_dedup",
            "subscription_id",
            "frequency",
            "report_date",
            "triggered_by",
            unique=True,
            postgresql_where=text(
                "status NOT IN ('superseded', 'failed') AND triggered_by = 'auto'"
            ),
            sqlite_where=text(
                "status NOT IN ('superseded', 'failed') AND triggered_by = 'auto'"
            ),
        ),
    )


class ScheduledReportLedgerEntry(Base):
    __tablename__ = "scheduled_report_ledger_entries"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    ledger_key: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    subscription_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("scheduled_report_subscriptions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    frequency: Mapped[str] = mapped_column(String(20), nullable=False)
    expected_date: Mapped[str] = mapped_column(String(20), nullable=False)
    expected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    email: Mapped[str | None] = mapped_column(String(256), nullable=True, comment="订阅邮箱快照；订阅留空时为 NULL")
    project_ids: Mapped[str] = mapped_column(String(500), nullable=False, default="*")
    country: Mapped[str] = mapped_column(String(256), nullable=False, default="US")
    status: Mapped[str] = mapped_column(String(20), nullable=False, default=LedgerStatus.MISSING.value, index=True)
    latest_delivery_log_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("scheduled_report_delivery_logs.id", ondelete="SET NULL"),
        nullable=True,
    )
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_checked_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    subscription: Mapped["ScheduledReportSubscription"] = relationship("ScheduledReportSubscription")
    latest_delivery_log: Mapped["ScheduledReportDeliveryLog | None"] = relationship("ScheduledReportDeliveryLog")
