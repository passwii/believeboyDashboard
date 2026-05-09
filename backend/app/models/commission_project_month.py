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


class CommissionProjectMonth(Base):
    __tablename__ = 'commission_project_months'
    __table_args__ = (
        UniqueConstraint('report_month', 'project_id', name='commission_project_months_unique_month_project'),
        CheckConstraint("report_month LIKE '____-__'", name='ck_commission_project_months_report_month_format'),
        CheckConstraint(
            "payment_status in ('unpaid', 'partial', 'paid')",
            name='ck_commission_project_months_payment_status',
        ),
        CheckConstraint('income_total_usd >= 0', name='ck_commission_project_months_income_total_usd'),
        CheckConstraint(
            'factory_commission_rate >= 0 and factory_commission_rate <= 1',
            name='ck_commission_project_months_factory_rate',
        ),
        CheckConstraint('usd_to_rmb_rate >= 0', name='ck_commission_project_months_exchange_rate'),
        CheckConstraint('factory_commission_usd >= 0', name='ck_commission_project_months_factory_commission_usd'),
        CheckConstraint('factory_commission_rmb >= 0', name='ck_commission_project_months_factory_commission_rmb'),
        CheckConstraint('received_rmb >= 0', name='ck_commission_project_months_received_rmb'),
        Index('idx_commission_project_months_month', 'report_month'),
        Index('idx_commission_project_months_payment_status', 'payment_status'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        primary_key=True,
        autoincrement=True,
    )
    report_month: Mapped[str] = mapped_column(String(7), nullable=False)
    project_id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, "sqlite"),
        ForeignKey('projects.id', ondelete='CASCADE'),
        nullable=False,
        index=True,
    )
    project_name: Mapped[str] = mapped_column(String(255), nullable=False)

    income_total_usd: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, server_default='0')
    factory_commission_rate: Mapped[Decimal] = mapped_column(Numeric(8, 6), nullable=False, server_default='0')
    usd_to_rmb_rate: Mapped[Decimal] = mapped_column(Numeric(18, 8), nullable=False, server_default='0')
    factory_commission_usd: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, server_default='0')
    factory_commission_rmb: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, server_default='0')

    payment_status: Mapped[str] = mapped_column(String(16), nullable=False, server_default='unpaid')
    received_rmb: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, server_default='0')
    payment_confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    payment_confirmed_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    note: Mapped[str | None] = mapped_column(String(500), nullable=True)

    computed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )
