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
    JSON,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base
from app.models.job import JobStatus


def _money_column() -> Mapped[Decimal]:
    return mapped_column(Numeric(18, 2), nullable=False, server_default='0')


class MonthlyReport(Base):
    __tablename__ = 'monthly_reports'
    __table_args__ = (
        UniqueConstraint('project_id', 'report_month', 'version', name='monthly_reports_project_month_version_key'),
        Index('idx_monthly_reports_project_month', 'project_id', 'report_month'),
        Index('idx_monthly_reports_project_month_current', 'project_id', 'report_month', 'is_current'),
        CheckConstraint("report_month LIKE '____-__'", name='ck_monthly_reports_report_month_format'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        primary_key=True,
        autoincrement=True,
    )
    project_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        ForeignKey('projects.id', ondelete='CASCADE'),
        nullable=False,
        index=True,
    )
    project_name: Mapped[str] = mapped_column(String(255), nullable=False)
    report_month: Mapped[str] = mapped_column(String(7), nullable=False, index=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False, server_default='1')
    is_current: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default='true', index=True)
    superseded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    transaction_file_id: Mapped[str] = mapped_column(String(255), nullable=False)
    transaction_file_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    summary_pdf_file_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    summary_pdf_file_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    result_file_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    settlement_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    file_size: Mapped[int | None] = mapped_column(BigInteger, nullable=True)

    total_transactions: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    total_orders: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    total_refunds: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    total_adjustments: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    total_service_fees: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    total_trans_fees: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')

    status: Mapped[JobStatus] = mapped_column(nullable=False, default=JobStatus.pending, index=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    calculation_version: Mapped[int] = mapped_column(Integer, nullable=False, server_default='1')
    computed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    transactions: Mapped[list['MonthlyReportTransaction']] = relationship(
        back_populates='report',
        cascade='all, delete-orphan',
    )
    pt3: Mapped['MonthlyReportPT3Calculation | None'] = relationship(
        back_populates='report',
        cascade='all, delete-orphan',
        uselist=False,
    )
    pt4: Mapped['MonthlyReportPT4Calculation | None'] = relationship(
        back_populates='report',
        cascade='all, delete-orphan',
        uselist=False,
    )
class MonthlyReportTransaction(Base):
    __tablename__ = 'monthly_report_transactions'
    __table_args__ = (
        UniqueConstraint('report_id', 'source_row_no', name='monthly_report_transactions_report_row_key'),
        Index('idx_monthly_transactions_report_type', 'report_id', 'transaction_type'),
        Index('idx_monthly_transactions_report_date', 'report_id', 'transaction_date'),
        Index('idx_monthly_transactions_report_sku', 'report_id', 'sku'),
        Index('idx_monthly_transactions_report_order', 'report_id', 'order_id'),
        CheckConstraint("report_month LIKE '____-__'", name='ck_monthly_transactions_report_month_format'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        primary_key=True,
        autoincrement=True,
    )
    report_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        ForeignKey('monthly_reports.id', ondelete='CASCADE'),
        nullable=False,
        index=True,
    )
    project_name: Mapped[str] = mapped_column(String(255), nullable=False)
    report_month: Mapped[str] = mapped_column(String(7), nullable=False, index=True)
    source_row_no: Mapped[int] = mapped_column(Integer, nullable=False)
    transaction_date: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    settlement_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    transaction_type: Mapped[str] = mapped_column(String(64), nullable=False)
    order_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    sku: Mapped[str | None] = mapped_column(String(128), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')

    marketplace: Mapped[str | None] = mapped_column(String(128), nullable=True)
    account_type: Mapped[str | None] = mapped_column(String(128), nullable=True)
    fulfillment: Mapped[str | None] = mapped_column(String(64), nullable=True)
    order_city: Mapped[str | None] = mapped_column(String(128), nullable=True)
    order_state: Mapped[str | None] = mapped_column(String(128), nullable=True)
    order_postal: Mapped[str | None] = mapped_column(String(32), nullable=True)
    tax_collection_model: Mapped[str | None] = mapped_column(String(128), nullable=True)

    product_sales: Mapped[Decimal] = _money_column()
    product_sales_tax: Mapped[Decimal] = _money_column()
    shipping_credits: Mapped[Decimal] = _money_column()
    shipping_credits_tax: Mapped[Decimal] = _money_column()
    gift_wrap_credits: Mapped[Decimal] = _money_column()
    gift_wrap_credits_tax: Mapped[Decimal] = _money_column()
    regulatory_fee: Mapped[Decimal] = _money_column()
    regulatory_fee_tax: Mapped[Decimal] = _money_column()
    promotional_rebates: Mapped[Decimal] = _money_column()
    promotional_rebates_tax: Mapped[Decimal] = _money_column()
    marketplace_withheld_tax: Mapped[Decimal] = _money_column()
    selling_fees: Mapped[Decimal] = _money_column()
    fba_fees: Mapped[Decimal] = _money_column()
    other_transaction_fees: Mapped[Decimal] = _money_column()
    other_amount: Mapped[Decimal] = _money_column()
    total: Mapped[Decimal] = _money_column()

    raw_row: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    report: Mapped[MonthlyReport] = relationship(back_populates='transactions')


class MonthlyReportPT3Calculation(Base):
    __tablename__ = 'monthly_report_pt3_calculation'
    __table_args__ = (
        UniqueConstraint('report_id', name='monthly_report_pt3_report_key'),
        CheckConstraint("report_month LIKE '____-__'", name='ck_monthly_pt3_report_month_format'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        primary_key=True,
        autoincrement=True,
    )
    report_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        ForeignKey('monthly_reports.id', ondelete='CASCADE'),
        nullable=False,
        index=True,
    )
    project_name: Mapped[str] = mapped_column(String(255), nullable=False)
    report_month: Mapped[str] = mapped_column(String(7), nullable=False, index=True)

    income_product_sales_non_fba: Mapped[Decimal] = _money_column()
    income_product_sale_refunds_non_fba: Mapped[Decimal] = _money_column()
    income_fba_product_sales: Mapped[Decimal] = _money_column()
    income_fba_product_sale_refunds: Mapped[Decimal] = _money_column()
    income_fba_inventory_credit: Mapped[Decimal] = _money_column()
    income_fba_liquidation_proceeds: Mapped[Decimal] = _money_column()
    income_shipping_credits: Mapped[Decimal] = _money_column()
    income_shipping_credit_refunds: Mapped[Decimal] = _money_column()
    income_gift_wrap_credits: Mapped[Decimal] = _money_column()
    income_gift_wrap_credits_refunds: Mapped[Decimal] = _money_column()
    income_promotional_rebates: Mapped[Decimal] = _money_column()
    income_promotional_rebate_refunds: Mapped[Decimal] = _money_column()
    income_a_to_z_guarantee_claims: Mapped[Decimal] = _money_column()
    income_chargebacks: Mapped[Decimal] = _money_column()
    income_safe_t_reimbursement: Mapped[Decimal] = _money_column()
    income_total: Mapped[Decimal] = _money_column()

    expense_seller_fulfilled_selling_fees: Mapped[Decimal] = _money_column()
    expense_fba_selling_fees: Mapped[Decimal] = _money_column()
    expense_selling_fee_refunds: Mapped[Decimal] = _money_column()
    expense_fba_transaction_fees: Mapped[Decimal] = _money_column()
    expense_fba_transaction_fee_refunds: Mapped[Decimal] = _money_column()
    expense_other_transaction_fees: Mapped[Decimal] = _money_column()
    expense_other_transaction_fee_refunds: Mapped[Decimal] = _money_column()
    expense_fba_inventory_and_inbound_services_fees: Mapped[Decimal] = _money_column()
    expense_shipping_label_purchases: Mapped[Decimal] = _money_column()
    expense_shipping_label_refunds: Mapped[Decimal] = _money_column()
    expense_carrier_shipping_label_adjustments: Mapped[Decimal] = _money_column()
    expense_service_fees: Mapped[Decimal] = _money_column()
    expense_refund_administration_fees: Mapped[Decimal] = _money_column()
    expense_adjustments: Mapped[Decimal] = _money_column()
    expense_cost_of_advertising: Mapped[Decimal] = _money_column()
    expense_refund_for_advertiser: Mapped[Decimal] = _money_column()
    expense_liquidations_fees: Mapped[Decimal] = _money_column()
    expense_receivables: Mapped[Decimal] = _money_column()
    expense_deductions: Mapped[Decimal] = _money_column()
    expense_amazon_shipping_charge_adjustments: Mapped[Decimal] = _money_column()
    expense_total: Mapped[Decimal] = _money_column()

    amazon_pay_back: Mapped[Decimal] = _money_column()
    advertising_percentage: Mapped[Decimal] = mapped_column(Numeric(8, 4), nullable=False, server_default='0')
    calculation_version: Mapped[int] = mapped_column(Integer, nullable=False, server_default='1')
    computed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    report: Mapped[MonthlyReport] = relationship(back_populates='pt3')


class MonthlyReportPT4Calculation(Base):
    __tablename__ = 'monthly_report_pt4_calculation'
    __table_args__ = (
        UniqueConstraint('report_id', name='monthly_report_pt4_report_key'),
        CheckConstraint("report_month LIKE '____-__'", name='ck_monthly_pt4_report_month_format'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        primary_key=True,
        autoincrement=True,
    )
    report_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        ForeignKey('monthly_reports.id', ondelete='CASCADE'),
        nullable=False,
        index=True,
    )
    project_name: Mapped[str] = mapped_column(String(255), nullable=False)
    report_month: Mapped[str] = mapped_column(String(7), nullable=False, index=True)

    income_sales: Mapped[Decimal] = _money_column()
    income_refund: Mapped[Decimal] = _money_column()
    income_adjustment: Mapped[Decimal] = _money_column()
    income_other: Mapped[Decimal] = _money_column()
    income_total: Mapped[Decimal] = _money_column()

    expense_selling_fee: Mapped[Decimal] = _money_column()
    expense_fba_fee: Mapped[Decimal] = _money_column()
    expense_inventory_fee: Mapped[Decimal] = _money_column()
    expense_service_fee: Mapped[Decimal] = _money_column()
    expense_advertising: Mapped[Decimal] = _money_column()
    expense_other_fees: Mapped[Decimal] = _money_column()
    expense_total: Mapped[Decimal] = _money_column()

    amazon_pay_back: Mapped[Decimal] = _money_column()
    credit_card_deduction_usd: Mapped[Decimal] = _money_column()
    calculation_version: Mapped[int] = mapped_column(Integer, nullable=False, server_default='1')
    computed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    report: Mapped[MonthlyReport] = relationship(back_populates='pt4')
