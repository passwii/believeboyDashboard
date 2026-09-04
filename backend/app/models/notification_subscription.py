"""Notification Subscription Model - per-project subscription rules."""

from __future__ import annotations

from datetime import datetime
from enum import Enum

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    func,
)
from sqlalchemy.dialects.postgresql import JSON
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base


class SubscriptionFrequency(str, Enum):
    DAILY = "daily"
    WEEKLY = "weekly"
    MONTHLY = "monthly"


class ReportType(str, Enum):
    DAILY_REPORT = "daily_report"
    FINANCIAL = "financial"
    PRODUCT_ANALYSIS = "product_analysis"


class NotificationSubscription(Base):
    __tablename__ = "notification_subscriptions"
    __table_args__ = (
        Index("idx_ns_project", "project_id"),
        Index("idx_ns_frequency", "frequency"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    rule_name: Mapped[str] = mapped_column(String(128), nullable=False)
    frequency: Mapped[str] = mapped_column(String(20), nullable=False)  # daily/weekly/monthly
    report_types: Mapped[list] = mapped_column(JSON, nullable=False, default=list)  # ["daily_report", "financial"]
    recipients: Mapped[list] = mapped_column(JSON, nullable=False, default=list)  # ["a@xxx.com"]
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_by: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False,
        server_default=func.now(), onupdate=func.now()
    )