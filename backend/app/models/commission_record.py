from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    Boolean,
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


class CommissionRecord(Base):
    __tablename__ = 'commission_records'
    __table_args__ = (
        UniqueConstraint(
            'report_month',
            'project_id',
            'person_name',
            'income_category',
            name='commission_records_unique_month_project_person_category',
        ),
        CheckConstraint("report_month LIKE '____-__'", name='ck_commission_records_report_month_format'),
        CheckConstraint("income_category in ('operator', 'assistant')", name='ck_commission_records_income_category'),
        CheckConstraint("payment_status in ('paid', 'unpaid')", name='ck_commission_records_payment_status'),
        CheckConstraint('factory_commission_rate >= 0 and factory_commission_rate <= 1', name='ck_commission_records_factory_rate'),
        CheckConstraint('operator_bonus_ratio >= 0 and operator_bonus_ratio <= 1', name='ck_commission_records_operator_bonus_ratio'),
        CheckConstraint('usd_to_rmb_rate >= 0', name='ck_commission_records_exchange_rate'),
        CheckConstraint("bonus_ratio_source in ('rule', 'manual')", name='ck_commission_records_bonus_ratio_source'),
        CheckConstraint(
            'manual_bonus_ratio is null or (manual_bonus_ratio >= 0 and manual_bonus_ratio <= 1)',
            name='ck_commission_records_manual_bonus_ratio',
        ),
        Index('idx_commission_records_month', 'report_month'),
        Index('idx_commission_records_person_month', 'person_name', 'report_month'),
        Index('idx_commission_records_month_active', 'report_month', 'is_active'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger(),
        primary_key=True,
        autoincrement=True,
    )
    report_month: Mapped[str] = mapped_column(String(7), nullable=False)
    project_id: Mapped[int] = mapped_column(
        BigInteger(),
        ForeignKey('projects.id', ondelete='CASCADE'),
        nullable=False,
        index=True,
    )
    project_name: Mapped[str] = mapped_column(String(255), nullable=False)
    person_name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    income_category: Mapped[str] = mapped_column(String(16), nullable=False)
    project_month_id: Mapped[int | None] = mapped_column(
        BigInteger(),
        ForeignKey('commission_project_months.id', ondelete='SET NULL'),
        nullable=True,
        index=True,
    )

    income_total_usd: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, server_default='0')
    factory_commission_rate: Mapped[Decimal] = mapped_column(Numeric(8, 6), nullable=False, server_default='0')
    operator_bonus_ratio: Mapped[Decimal] = mapped_column(Numeric(8, 6), nullable=False, server_default='0')
    bonus_amount_usd: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, server_default='0')
    usd_to_rmb_rate: Mapped[Decimal] = mapped_column(Numeric(18, 8), nullable=False, server_default='0')
    bonus_amount_rmb: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, server_default='0')
    bonus_ratio_source: Mapped[str] = mapped_column(String(16), nullable=False, server_default='rule')
    manual_bonus_ratio: Mapped[Decimal | None] = mapped_column(Numeric(8, 6), nullable=True)

    payment_status: Mapped[str] = mapped_column(String(16), nullable=False, server_default='unpaid')
    payment_confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    payment_confirmed_by: Mapped[str | None] = mapped_column(String(255), nullable=True)

    is_locked: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default='false')
    locked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    locked_by: Mapped[str | None] = mapped_column(String(255), nullable=True)

    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default='true')
    deactivated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    computed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )
