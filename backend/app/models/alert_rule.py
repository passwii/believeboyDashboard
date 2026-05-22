from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base


class AlertSeverity(str):
    INFO = "info"
    WARNING = "warning"
    CRITICAL = "critical"


class AlertCondition(str):
    BELOW = "below"
    ABOVE = "above"
    DROP_PCT = "drop_pct"
    RISE_PCT = "rise_pct"


class AlertMetric(str):
    SALES_AMOUNT = "sales_amount"
    ORDER_QTY = "order_qty"
    AD_SPEND = "ad_spend"
    ACOS = "acos"
    RETURN_RATE = "return_rate"
    INVENTORY_RISK = "inventory_risk"
    RECONCILIATION_MISMATCH = "reconciliation_mismatch"


class AlertTriggerType(str):
    THRESHOLD = "threshold"
    BASELINE = "baseline"


class AlertNotificationChannel(str):
    EMAIL = "email"
    IN_APP = "in_app"
    BOTH = "both"


class AlertRule(Base):
    __tablename__ = "alert_rules"
    __table_args__ = (
        Index("idx_ar_project_country", "project_id", "country"),
        Index("idx_ar_metric_active", "metric", "is_active"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    project_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    country: Mapped[str] = mapped_column(String(2), nullable=False, default="US")
    metric: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    trigger_type: Mapped[str] = mapped_column(
        String(16), nullable=False, default=AlertTriggerType.THRESHOLD
    )
    condition: Mapped[str] = mapped_column(String(16), nullable=False)
    threshold: Mapped[float] = mapped_column(Float, nullable=False)
    window_days: Mapped[int] = mapped_column(Integer, nullable=False, default=7)
    severity: Mapped[str] = mapped_column(String(16), nullable=False, default=AlertSeverity.WARNING)
    notification_channels: Mapped[str] = mapped_column(
        String(16), nullable=False, default=AlertNotificationChannel.IN_APP
    )
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_by: Mapped[str] = mapped_column(String(128), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False,
        server_default=func.now(), onupdate=func.now()
    )

    events: Mapped[list["AlertEvent"]] = relationship(
        back_populates="rule", cascade="all, delete-orphan"
    )