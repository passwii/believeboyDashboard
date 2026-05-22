"""Scheduled Report Subscription and Delivery Log Models."""

from __future__ import annotations

from datetime import datetime
from enum import Enum

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base


class ReportFrequency(str, Enum):
    DAILY = "daily"
    WEEKLY = "weekly"
    MONTHLY = "monthly"


class DeliveryStatus(str, Enum):
    PENDING = "pending"
    SENT = "sent"
    FAILED = "failed"


class ScheduledReportSubscription(Base):
    __tablename__ = "scheduled_report_subscriptions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    email: Mapped[str] = mapped_column(String(256), nullable=False)
    project_ids: Mapped[str] = mapped_column(String(500), nullable=False, default="*")
    country: Mapped[str] = mapped_column(String(10), nullable=False, default="US")
    frequency: Mapped[str] = mapped_column(String(20), nullable=False)
    ai_model: Mapped[str | None] = mapped_column(String(64), nullable=True, comment="AI 摘要使用的模型，空则用默认模型")
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


class ScheduledReportDeliveryLog(Base):
    __tablename__ = "scheduled_report_delivery_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    subscription_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("scheduled_report_subscriptions.id", ondelete="CASCADE"), nullable=False
    )
    frequency: Mapped[str] = mapped_column(String(20), nullable=False)
    report_date: Mapped[str] = mapped_column(String(20), nullable=False)
    report_month: Mapped[str | None] = mapped_column(String(10), nullable=True)
    email: Mapped[str] = mapped_column(String(256), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default=DeliveryStatus.PENDING.value)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    # Relationships
    subscription: Mapped["ScheduledReportSubscription"] = relationship(
        "ScheduledReportSubscription", back_populates="delivery_logs"
    )
