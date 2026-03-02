from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class CommissionRatioOverride(Base):
    __tablename__ = 'commission_ratio_overrides'
    __table_args__ = (
        UniqueConstraint(
            'report_month',
            'project_id',
            'person_name',
            'income_category',
            name='commission_ratio_overrides_unique_month_project_person_category',
        ),
        CheckConstraint("report_month LIKE '____-__'", name='ck_commission_ratio_overrides_report_month_format'),
        CheckConstraint("income_category in ('operator', 'assistant')", name='ck_commission_ratio_overrides_income_category'),
        CheckConstraint('override_ratio >= 0 and override_ratio <= 1', name='ck_commission_ratio_overrides_ratio'),
        Index('idx_commission_ratio_overrides_month', 'report_month'),
        Index('idx_commission_ratio_overrides_person_month', 'person_name', 'report_month'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        primary_key=True,
        autoincrement=True,
    )
    report_month: Mapped[str] = mapped_column(String(7), nullable=False)
    project_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        ForeignKey('projects.id', ondelete='CASCADE'),
        nullable=False,
        index=True,
    )
    project_name: Mapped[str] = mapped_column(String(255), nullable=False)
    person_name: Mapped[str] = mapped_column(String(255), nullable=False)
    income_category: Mapped[str] = mapped_column(String(16), nullable=False)
    override_ratio: Mapped[Decimal] = mapped_column(Numeric(8, 6), nullable=False)
    reason: Mapped[str | None] = mapped_column(String(500), nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String(255), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )
