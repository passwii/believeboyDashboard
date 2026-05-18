from datetime import datetime

from sqlalchemy import (
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base


class AlertEventStatus(str):
    ACTIVE = "active"
    ACKNOWLEDGED = "acknowledged"
    RESOLVED = "resolved"


class AlertEvent(Base):
    __tablename__ = "alert_events"
    __table_args__ = (
        Index("idx_ae_project_severity", "project_id", "severity"),
        Index("idx_ae_status_triggered", "status", "triggered_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    rule_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("alert_rules.id", ondelete="CASCADE"), nullable=False
    )
    project_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    metric: Mapped[str] = mapped_column(String(32), nullable=False)
    current_value: Mapped[float] = mapped_column(Float, nullable=False)
    baseline_value: Mapped[float] = mapped_column(Float, nullable=False)
    deviation_pct: Mapped[float] = mapped_column(Float, nullable=False)
    severity: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default=AlertEventStatus.ACTIVE, index=True
    )
    triggered_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), index=True
    )
    acknowledged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    acknowledged_by: Mapped[str | None] = mapped_column(String(128), nullable=True)

    rule: Mapped["AlertRule"] = relationship(back_populates="events")