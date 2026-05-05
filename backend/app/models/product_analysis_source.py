from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
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


def _money_column() -> Mapped[Decimal]:
    return mapped_column(Numeric(18, 2), nullable=False, server_default='0')


class AnalysisSourceFile(Base):
    __tablename__ = 'analysis_source_files'
    __table_args__ = (
        UniqueConstraint(
            'project_id',
            'report_type',
            'country',
            'period_start_date',
            'period_end_date',
            'version',
            name='analysis_sources_period_version_key',
        ),
        CheckConstraint(
            "report_type in ('business_report', 'payment_report', 'ad_product_report', 'sales_report', 'inventory_report', 'return_report')",
            name='ck_analysis_sources_report_type',
        ),
        CheckConstraint('version >= 1', name='ck_analysis_sources_version_positive'),
        CheckConstraint(
            "ingestion_status in ('pending', 'running', 'success', 'failed')",
            name='ck_analysis_sources_ingestion_status',
        ),
        CheckConstraint(
            "("
            "report_type in ('business_report', 'payment_report', 'ad_product_report', 'sales_report', 'return_report') "
            'and period_start_date is not null '
            'and period_end_date is not null '
            'and period_start_date <= period_end_date '
            'and snapshot_at is null'
            ")"
            " or "
            "("
            "report_type = 'inventory_report' "
            'and snapshot_at is not null'
            ")",
            name='ck_analysis_sources_period_or_snapshot',
        ),
        Index('idx_analysis_sources_project_id', 'project_id'),
        Index('idx_analysis_sources_report_type', 'report_type'),
        Index('idx_analysis_sources_country', 'country'),
        Index('idx_analysis_sources_is_current', 'is_current'),
        Index('idx_analysis_sources_ingestion_status', 'ingestion_status'),
        Index(
            'idx_analysis_sources_project_type_country_report_date',
            'project_id',
            'report_type',
            'country',
            'report_date',
        ),
        Index(
            'idx_analysis_sources_project_type_country_period',
            'project_id',
            'report_type',
            'country',
            'period_start_date',
            'period_end_date',
        ),
    )

    id: Mapped[int] = mapped_column(
        BigInteger(),
        primary_key=True,
        autoincrement=True,
    )
    project_id: Mapped[int] = mapped_column(
        BigInteger(),
        ForeignKey('projects.id', ondelete='CASCADE'),
        nullable=False,
    )
    report_type: Mapped[str] = mapped_column(String(32), nullable=False)
    country: Mapped[str] = mapped_column(String(2), nullable=False, default='US', server_default='US')
    report_date: Mapped[date | None] = mapped_column(Date(), nullable=True)
    period_start_date: Mapped[date | None] = mapped_column(Date(), nullable=True)
    period_end_date: Mapped[date | None] = mapped_column(Date(), nullable=True)
    snapshot_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False, server_default='1')
    is_current: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default='false')
    superseded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    upload_file_id: Mapped[str] = mapped_column(String(255), nullable=False)
    upload_file_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    original_filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
    stored_filename: Mapped[str] = mapped_column(String(255), nullable=False)
    logical_filename: Mapped[str] = mapped_column(String(255), nullable=False)
    storage_key: Mapped[str] = mapped_column(String(1024), nullable=False)
    file_size_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    file_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)

    ingestion_status: Mapped[str] = mapped_column(String(16), nullable=False, server_default='pending')
    ingestion_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    row_count_total: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    row_count_included: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    created_by: Mapped[str | None] = mapped_column(String(255), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    business_rows: Mapped[list['AnalysisBusinessRow']] = relationship(
        back_populates='source_file',
        cascade='all, delete-orphan',
    )
    payment_rows: Mapped[list['AnalysisPaymentRow']] = relationship(
        back_populates='source_file',
        cascade='all, delete-orphan',
    )
    ad_rows: Mapped[list['AnalysisAdProductRow']] = relationship(
        back_populates='source_file',
        cascade='all, delete-orphan',
    )
    inventory_rows: Mapped[list['InventorySnapshotRow']] = relationship(
        back_populates='source_file',
        cascade='all, delete-orphan',
    )
    sales_order_rows: Mapped[list['AnalysisSalesOrderRow']] = relationship(
        back_populates='source_file',
        cascade='all, delete-orphan',
    )
    return_rows: Mapped[list['AnalysisReturnRow']] = relationship(
        back_populates='source_file',
        cascade='all, delete-orphan',
    )


class AnalysisBusinessRow(Base):
    __tablename__ = 'analysis_business_rows'
    __table_args__ = (
        UniqueConstraint('source_file_id', 'source_row_no', name='analysis_business_rows_source_row_key'),
        Index('idx_analysis_business_source_id', 'source_file_id'),
        Index('idx_analysis_business_source_asin', 'source_file_id', 'asin'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger(),
        primary_key=True,
        autoincrement=True,
    )
    source_file_id: Mapped[int] = mapped_column(
        BigInteger(),
        ForeignKey('analysis_source_files.id', ondelete='CASCADE'),
        nullable=False,
    )
    source_row_no: Mapped[int] = mapped_column(Integer, nullable=False)
    asin: Mapped[str | None] = mapped_column(String(64), nullable=True)
    page_views: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    units_ordered: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    sessions: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    ordered_sales_amount: Mapped[Decimal] = _money_column()
    raw_row: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    source_file: Mapped[AnalysisSourceFile] = relationship(back_populates='business_rows')


class AnalysisPaymentRow(Base):
    __tablename__ = 'analysis_payment_rows'
    __table_args__ = (
        UniqueConstraint('source_file_id', 'source_row_no', name='analysis_payment_rows_source_row_key'),
        CheckConstraint(
            "scope_status in ('included_product', 'excluded_store_level', 'excluded_unmapped')",
            name='ck_analysis_payment_scope_status',
        ),
        Index('idx_analysis_payment_source_id', 'source_file_id'),
        Index('idx_analysis_payment_source_sku', 'source_file_id', 'sku'),
        Index('idx_analysis_payment_source_asin', 'source_file_id', 'asin'),
        Index('idx_analysis_payment_scope', 'source_file_id', 'scope_status'),
        Index('idx_analysis_payment_type', 'source_file_id', 'transaction_type'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger(),
        primary_key=True,
        autoincrement=True,
    )
    source_file_id: Mapped[int] = mapped_column(
        BigInteger(),
        ForeignKey('analysis_source_files.id', ondelete='CASCADE'),
        nullable=False,
    )
    source_row_no: Mapped[int] = mapped_column(Integer, nullable=False)
    transaction_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    transaction_type: Mapped[str] = mapped_column(String(64), nullable=False)
    order_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    sku: Mapped[str | None] = mapped_column(String(128), nullable=True)
    asin: Mapped[str | None] = mapped_column(String(64), nullable=True)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    product_sales: Mapped[Decimal] = _money_column()
    shipping_credits: Mapped[Decimal] = _money_column()
    promotional_rebates: Mapped[Decimal] = _money_column()
    other_amount: Mapped[Decimal] = _money_column()
    selling_fees: Mapped[Decimal] = _money_column()
    fba_fees: Mapped[Decimal] = _money_column()
    total_amount: Mapped[Decimal] = _money_column()
    scope_status: Mapped[str] = mapped_column(String(32), nullable=False, server_default='excluded_unmapped')
    scope_reason: Mapped[str | None] = mapped_column(String(255), nullable=True)
    raw_row: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    source_file: Mapped[AnalysisSourceFile] = relationship(back_populates='payment_rows')


class AnalysisAdProductRow(Base):
    __tablename__ = 'analysis_ad_product_rows'
    __table_args__ = (
        UniqueConstraint('source_file_id', 'source_row_no', name='analysis_ad_product_rows_source_row_key'),
        CheckConstraint(
            "scope_status in ('included_product', 'excluded_store_level', 'excluded_unmapped')",
            name='ck_analysis_ad_product_scope_status',
        ),
        Index('idx_analysis_ad_product_source_id', 'source_file_id'),
        Index('idx_analysis_ad_product_source_sku', 'source_file_id', 'sku'),
        Index('idx_analysis_ad_product_scope', 'source_file_id', 'scope_status'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger(),
        primary_key=True,
        autoincrement=True,
    )
    source_file_id: Mapped[int] = mapped_column(
        BigInteger(),
        ForeignKey('analysis_source_files.id', ondelete='CASCADE'),
        nullable=False,
    )
    source_row_no: Mapped[int] = mapped_column(Integer, nullable=False)
    sku: Mapped[str | None] = mapped_column(String(128), nullable=True)
    asin: Mapped[str | None] = mapped_column(String(64), nullable=True)
    impressions: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    clicks: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    spend: Mapped[Decimal] = _money_column()
    sales_7d: Mapped[Decimal] = _money_column()
    orders_7d: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    scope_status: Mapped[str] = mapped_column(String(32), nullable=False, server_default='excluded_unmapped')
    scope_reason: Mapped[str | None] = mapped_column(String(255), nullable=True)
    raw_row: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    source_file: Mapped[AnalysisSourceFile] = relationship(back_populates='ad_rows')


class InventorySnapshotRow(Base):
    __tablename__ = 'inventory_snapshot_rows'
    __table_args__ = (
        UniqueConstraint('source_file_id', 'source_row_no', name='inventory_snapshot_rows_source_row_key'),
        CheckConstraint("stock_status in ('in_stock', 'out_of_stock')", name='ck_inventory_snapshot_stock_status'),
        CheckConstraint("aging_status in ('fresh', 'aging', 'over_aged')", name='ck_inventory_snapshot_aging_status'),
        Index('idx_inventory_snapshot_source_id', 'source_file_id'),
        Index('idx_inventory_snapshot_source_sku', 'source_file_id', 'sku'),
        Index('idx_inventory_snapshot_stock', 'source_file_id', 'stock_status'),
        Index('idx_inventory_snapshot_aging', 'source_file_id', 'aging_status'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger(),
        primary_key=True,
        autoincrement=True,
    )
    source_file_id: Mapped[int] = mapped_column(
        BigInteger(),
        ForeignKey('analysis_source_files.id', ondelete='CASCADE'),
        nullable=False,
    )
    source_row_no: Mapped[int] = mapped_column(Integer, nullable=False)
    sku: Mapped[str | None] = mapped_column(String(128), nullable=True)
    asin: Mapped[str | None] = mapped_column(String(64), nullable=True)
    available_qty: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    age_0_90_qty: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    age_91_180_qty: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    age_181_270_qty: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    age_271_365_qty: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    age_365_plus_qty: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    recommended_action: Mapped[str | None] = mapped_column(String(255), nullable=True)
    stock_status: Mapped[str] = mapped_column(String(16), nullable=False)
    aging_status: Mapped[str] = mapped_column(String(16), nullable=False)
    raw_row: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    source_file: Mapped[AnalysisSourceFile] = relationship(back_populates='inventory_rows')


class AnalysisReturnRow(Base):
    __tablename__ = 'analysis_return_rows'
    __table_args__ = (
        UniqueConstraint('source_file_id', 'source_row_no', name='analysis_return_rows_source_row_key'),
        Index('idx_analysis_return_source_id', 'source_file_id'),
        Index('idx_analysis_return_source_date', 'source_file_id', 'return_date'),
        Index('idx_analysis_return_sku', 'sku'),
        Index('idx_analysis_return_order_id', 'order_id'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger(),
        primary_key=True,
        autoincrement=True,
    )
    source_file_id: Mapped[int] = mapped_column(
        BigInteger(),
        ForeignKey('analysis_source_files.id', ondelete='CASCADE'),
        nullable=False,
    )
    source_row_no: Mapped[int] = mapped_column(Integer, nullable=False)
    return_date: Mapped[date] = mapped_column(Date(), nullable=False)
    order_id: Mapped[str] = mapped_column(String(50), nullable=False)
    sku: Mapped[str] = mapped_column(String(100), nullable=False)
    asin: Mapped[str | None] = mapped_column(String(20), nullable=True)
    fnsku: Mapped[str | None] = mapped_column(String(20), nullable=True)
    product_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False, server_default='1')
    fulfillment_center_id: Mapped[str | None] = mapped_column(String(20), nullable=True)
    detailed_disposition: Mapped[str] = mapped_column(String(50), nullable=False)
    reason: Mapped[str] = mapped_column(String(100), nullable=False)
    status: Mapped[str] = mapped_column(String(100), nullable=False)
    license_plate_number: Mapped[str | None] = mapped_column(String(30), nullable=True)
    original_return_datetime: Mapped[str] = mapped_column(String(30), nullable=False)
    customer_comments: Mapped[str | None] = mapped_column(Text, nullable=True)
    raw_row: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    source_file: Mapped[AnalysisSourceFile] = relationship(back_populates='return_rows')


class AnalysisSalesOrderRow(Base):
    __tablename__ = 'analysis_sales_order_rows'
    __table_args__ = (
        UniqueConstraint('source_file_id', 'source_row_no', name='analysis_sales_order_rows_source_row_key'),
        Index('idx_analysis_sales_order_source_id', 'source_file_id'),
        Index('idx_analysis_sales_order_source_purchase_date', 'source_file_id', 'purchase_date_pt'),
        Index('idx_analysis_sales_order_source_status', 'source_file_id', 'order_status'),
        Index('idx_analysis_sales_order_source_sku', 'source_file_id', 'sku'),
        Index('idx_analysis_sales_order_order_id', 'amazon_order_id'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger(),
        primary_key=True,
        autoincrement=True,
    )
    source_file_id: Mapped[int] = mapped_column(
        BigInteger(),
        ForeignKey('analysis_source_files.id', ondelete='CASCADE'),
        nullable=False,
    )
    source_row_no: Mapped[int] = mapped_column(Integer, nullable=False)
    amazon_order_id: Mapped[str] = mapped_column(String(64), nullable=False)
    purchase_at_utc: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    purchase_at_pt: Mapped[datetime] = mapped_column(DateTime(timezone=False), nullable=False)
    purchase_date_pt: Mapped[date] = mapped_column(Date(), nullable=False)
    order_status: Mapped[str] = mapped_column(String(32), nullable=False)
    sku: Mapped[str | None] = mapped_column(String(128), nullable=True)
    asin: Mapped[str | None] = mapped_column(String(64), nullable=True)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    item_price: Mapped[Decimal] = _money_column()
    shipping_price: Mapped[Decimal] = _money_column()
    currency: Mapped[str | None] = mapped_column(String(8), nullable=True)
    is_counted_sales: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default='false')
    status_rule_version: Mapped[int] = mapped_column(Integer, nullable=False, server_default='1')
    raw_row: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    source_file: Mapped[AnalysisSourceFile] = relationship(back_populates='sales_order_rows')


class AnalysisPT1Calculation(Base):
    __tablename__ = 'analysis_pt1_calculation'
    __table_args__ = (
        UniqueConstraint(
            'project_id',
            'country',
            'report_start_date',
            'report_end_date',
            'version',
            name='analysis_pt1_project_period_version_key',
        ),
        CheckConstraint('version >= 1', name='ck_analysis_pt1_version_positive'),
        CheckConstraint('report_start_date <= report_end_date', name='ck_analysis_pt1_period_valid'),
        Index('idx_analysis_pt1_project_id', 'project_id'),
        Index('idx_analysis_pt1_project_country_period', 'project_id', 'country', 'report_start_date', 'report_end_date'),
        Index('idx_analysis_pt1_country', 'country'),
        Index('idx_analysis_pt1_project_country_period_current', 'project_id', 'country', 'report_start_date', 'report_end_date', 'is_current'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger(),
        primary_key=True,
        autoincrement=True,
    )
    project_id: Mapped[int] = mapped_column(
        BigInteger(),
        ForeignKey('projects.id', ondelete='CASCADE'),
        nullable=False,
    )
    country: Mapped[str] = mapped_column(String(2), nullable=False, default='US', server_default='US')
    project_name: Mapped[str] = mapped_column(String(255), nullable=False)
    report_start_date: Mapped[date] = mapped_column(Date(), nullable=False)
    report_end_date: Mapped[date] = mapped_column(Date(), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False, server_default='1')
    is_current: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default='true')
    superseded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    row_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    summary_row: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    result_file_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)

    calculation_version: Mapped[int] = mapped_column(Integer, nullable=False, server_default='1')
    computed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    pt_sku_details: Mapped[list['AnalysisPTSKUDetail']] = relationship(
        back_populates='pt1_calculation',
        cascade='all, delete-orphan',
    )


class AnalysisPTSKUDetail(Base):
    __tablename__ = 'analysis_pt_sku_details'
    __table_args__ = (
        UniqueConstraint('pt1_calculation_id', 'country', 'source_row_no', name='analysis_pt_sku_details_row_key'),
        Index('idx_analysis_pt_sku_details_pt1', 'pt1_calculation_id'),
        Index('idx_analysis_pt_sku_details_pt1_country', 'pt1_calculation_id', 'country'),
        Index('idx_analysis_pt_sku_details_sku', 'pt1_calculation_id', 'sku'),
        Index('idx_analysis_pt_sku_details_asin', 'pt1_calculation_id', 'asin'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger(),
        primary_key=True,
        autoincrement=True,
    )
    pt1_calculation_id: Mapped[int] = mapped_column(
        BigInteger(),
        ForeignKey('analysis_pt1_calculation.id', ondelete='CASCADE'),
        nullable=False,
    )
    country: Mapped[str] = mapped_column(String(2), nullable=False, default='US', server_default='US')
    source_row_no: Mapped[int] = mapped_column(Integer, nullable=False)

    report_date: Mapped[str | None] = mapped_column(String(32), nullable=True)
    sku: Mapped[str | None] = mapped_column(String(128), nullable=True)
    asin: Mapped[str | None] = mapped_column(String(64), nullable=True)

    total_units: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    total_sales_amount: Mapped[Decimal] = _money_column()
    page_views: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    total_visitors: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    ad_impressions: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    ad_clicks: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    ad_orders: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    ad_spend: Mapped[Decimal] = _money_column()
    ad_sales_amount: Mapped[Decimal] = _money_column()
    actual_sales_amount: Mapped[Decimal] = _money_column()
    actual_sales_units: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    actual_refund_amount: Mapped[Decimal] = _money_column()
    actual_refund_units: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    profit_amount: Mapped[Decimal] = _money_column()
    profit_rate: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')

    raw_row: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    pt1_calculation: Mapped[AnalysisPT1Calculation] = relationship(back_populates='pt_sku_details')
