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


class DailySourceFile(Base):
    __tablename__ = 'daily_source_files'
    __table_args__ = (
        UniqueConstraint(
            'project_id',
            'report_type',
            'report_date',
            'version',
            name='daily_sources_date_version_key',
        ),
        CheckConstraint(
            "report_type in ('sales_report', 'ad_report')",
            name='ck_daily_sources_report_type',
        ),
        CheckConstraint('version >= 1', name='ck_daily_sources_version_positive'),
        CheckConstraint(
            "ingestion_status in ('pending', 'running', 'success', 'failed')",
            name='ck_daily_sources_ingestion_status',
        ),
        Index('idx_daily_sources_project_id', 'project_id'),
        Index('idx_daily_sources_report_type', 'report_type'),
        Index('idx_daily_sources_report_date', 'report_date'),
        Index('idx_daily_sources_is_current', 'is_current'),
        Index('idx_daily_sources_ingestion_status', 'ingestion_status'),
        Index(
            'idx_daily_sources_project_type_date',
            'project_id',
            'report_type',
            'report_date',
        ),
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
    )
    report_type: Mapped[str] = mapped_column(String(32), nullable=False)
    report_date: Mapped[date] = mapped_column(Date(), nullable=False)
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

    sales_orders: Mapped[list['DailySalesOrder']] = relationship(
        back_populates='source_file',
        cascade='all, delete-orphan',
    )
    ad_products: Mapped[list['DailyAdProduct']] = relationship(
        back_populates='source_file',
        cascade='all, delete-orphan',
    )


class DailySalesOrder(Base):
    __tablename__ = 'daily_sales_order'
    __table_args__ = (
        UniqueConstraint('source_file_id', 'source_row_no', name='daily_sales_order_source_row_key'),
        Index('idx_daily_sales_order_source_id', 'source_file_id'),
        Index('idx_daily_sales_order_source_purchase_date', 'source_file_id', 'purchase_date_pt'),
        Index('idx_daily_sales_order_source_status', 'source_file_id', 'order_status'),
        Index('idx_daily_sales_order_source_sku', 'source_file_id', 'sku'),
        Index('idx_daily_sales_order_order_id', 'amazon_order_id'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        primary_key=True,
        autoincrement=True,
    )
    source_file_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        ForeignKey('daily_source_files.id', ondelete='CASCADE'),
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
    currency: Mapped[str | None] = mapped_column(String(8), nullable=True)
    is_counted_sales: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default='false')
    status_rule_version: Mapped[int] = mapped_column(Integer, nullable=False, server_default='1')
    raw_row: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    source_file: Mapped[DailySourceFile] = relationship(back_populates='sales_orders')


class DailyAdProduct(Base):
    __tablename__ = 'daily_ad_product'
    __table_args__ = (
        UniqueConstraint('source_file_id', 'source_row_no', name='daily_ad_product_source_row_key'),
        CheckConstraint(
            "scope_status in ('included_product', 'excluded_store_level', 'excluded_unmapped')",
            name='ck_daily_ad_product_scope_status',
        ),
        Index('idx_daily_ad_product_source_id', 'source_file_id'),
        Index('idx_daily_ad_product_source_sku', 'source_file_id', 'sku'),
        Index('idx_daily_ad_product_scope', 'source_file_id', 'scope_status'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        primary_key=True,
        autoincrement=True,
    )
    source_file_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        ForeignKey('daily_source_files.id', ondelete='CASCADE'),
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

    source_file: Mapped[DailySourceFile] = relationship(back_populates='ad_products')
