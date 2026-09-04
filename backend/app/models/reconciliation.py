from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    Numeric,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base


class ReconciliationRecord(Base):
    __tablename__ = "reconciliation_records"
    __table_args__ = (
        UniqueConstraint("report_id", "mode", name="reconciliation_records_report_mode_key"),
        Index("idx_reconciliation_report", "report_id"),
        Index("idx_reconciliation_created", "created_at"),
    )

    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True)
    report_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        ForeignKey("monthly_reports.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    operator: Mapped[str] = mapped_column(String(255), nullable=False)
    mode: Mapped[str] = mapped_column(String(20), nullable=False, default="auto")

    match_rate: Mapped[Decimal] = mapped_column(Numeric(5, 2), nullable=False, server_default="0")
    matched_items: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    mismatched_items: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    missing_items: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")

    detail_json: Mapped[dict] = mapped_column(JSON, nullable=False, default=list)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    report: Mapped["MonthlyReport | None"] = relationship(back_populates="reconciliation_records")


from app.models.monthly_report import MonthlyReport
