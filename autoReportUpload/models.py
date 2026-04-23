"""
SQLAlchemy models for the auto-report-upload service.
Copied and adapted from backend/app/models/ — no FastAPI dependencies.
"""

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
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


def _money_column() -> Mapped[Decimal]:
    return mapped_column(Numeric(18, 2), nullable=False, server_default="0")


# ─── projects ──────────────────────────────────────────────────────────────────


class Project(Base):
    __tablename__ = "projects"
    __table_args__ = (
        UniqueConstraint("project_name", name="projects_project_name_key"),
        CheckConstraint("sort_order >= 0", name="projects_sort_order_check"),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        primary_key=True,
        autoincrement=True,
    )
    project_name: Mapped[str] = mapped_column(String, nullable=False, index=True)
    brand_name: Mapped[str | None] = mapped_column(String, nullable=True)
    store_address: Mapped[str | None] = mapped_column(String, nullable=True)
    project_operator: Mapped[str | None] = mapped_column(Text, nullable=True)
    assistant_operator: Mapped[str | None] = mapped_column(Text, nullable=True)
    commission_basis: Mapped[str | None] = mapped_column(String, nullable=True)
    commission_rate: Mapped[Decimal | None] = mapped_column(Numeric(7, 4), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    source_file: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


# ─── product_costs ─────────────────────────────────────────────────────────────


class ProductCost(Base):
    __tablename__ = "product_costs"
    __table_args__ = (
        UniqueConstraint(
            "project_name",
            "sku",
            "asin",
            "country",
            name="product_costs_project_sku_asin_country_key",
        ),
        Index("idx_product_costs_project_sort", "project_name", "sort_order", "id"),
        Index("idx_product_costs_project_sku_active", "project_name", "sku", "is_active"),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        primary_key=True,
        autoincrement=True,
    )
    project_name: Mapped[str] = mapped_column(String, nullable=False, index=True)
    sku: Mapped[str] = mapped_column(String, nullable=False, index=True)
    asin: Mapped[str] = mapped_column(String, nullable=False, index=True)
    fnsku: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    product_name: Mapped[str | None] = mapped_column(String, nullable=True)
    fob_unit_cost: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    first_leg_cost_rmb: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    package_length_cm: Mapped[float] = mapped_column(Numeric(10, 2), nullable=False, default=0)
    package_width_cm: Mapped[float] = mapped_column(Numeric(10, 2), nullable=False, default=0)
    package_height_cm: Mapped[float] = mapped_column(Numeric(10, 2), nullable=False, default=0)
    weight_kg: Mapped[float] = mapped_column(Numeric(10, 3), nullable=False, default=0)
    carton_length_cm: Mapped[float] = mapped_column(Numeric(10, 2), nullable=False, default=0)
    carton_width_cm: Mapped[float] = mapped_column(Numeric(10, 2), nullable=False, default=0)
    carton_height_cm: Mapped[float] = mapped_column(Numeric(10, 2), nullable=False, default=0)
    carton_weight_kg: Mapped[float] = mapped_column(Numeric(10, 3), nullable=False, default=0)
    units_per_carton: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    currency: Mapped[str] = mapped_column(String, nullable=False, default="CNY")
    country: Mapped[str] = mapped_column(
        String(2), nullable=False, default="US", index=True
    )
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    source_file: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


# ─── analysis_source_files ─────────────────────────────────────────────────────


class AnalysisSourceFile(Base):
    __tablename__ = "analysis_source_files"
    __table_args__ = (
        UniqueConstraint(
            "project_id",
            "report_type",
            "country",
            "period_start_date",
            "period_end_date",
            "version",
            name="analysis_sources_period_version_key",
        ),
        CheckConstraint(
            "report_type in ('business_report', 'payment_report', 'ad_product_report', "
            "'sales_report', 'inventory_report', 'return_report')",
            name="ck_analysis_sources_report_type",
        ),
        CheckConstraint("version >= 1", name="ck_analysis_sources_version_positive"),
        CheckConstraint(
            "ingestion_status in ('pending', 'running', 'success', 'failed')",
            name="ck_analysis_sources_ingestion_status",
        ),
        CheckConstraint(
            "("
            "report_type in ('business_report', 'payment_report', 'ad_product_report', "
            "'sales_report', 'return_report') "
            "and period_start_date is not null "
            "and period_end_date is not null "
            "and period_start_date <= period_end_date "
            "and snapshot_at is null"
            ")"
            " or "
            "("
            "report_type = 'inventory_report' "
            "and snapshot_at is not null"
            ")",
            name="ck_analysis_sources_period_or_snapshot",
        ),
        Index("idx_analysis_sources_project_id", "project_id"),
        Index("idx_analysis_sources_report_type", "report_type"),
        Index("idx_analysis_sources_country", "country"),
        Index("idx_analysis_sources_is_current", "is_current"),
        Index("idx_analysis_sources_ingestion_status", "ingestion_status"),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        primary_key=True,
        autoincrement=True,
    )
    project_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
    )
    report_type: Mapped[str] = mapped_column(String(32), nullable=False)
    country: Mapped[str] = mapped_column(String(2), nullable=False, default="US")
    report_date: Mapped[date | None] = mapped_column(Date(), nullable=True)
    period_start_date: Mapped[date | None] = mapped_column(Date(), nullable=True)
    period_end_date: Mapped[date | None] = mapped_column(Date(), nullable=True)
    snapshot_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    is_current: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    superseded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    upload_file_id: Mapped[str] = mapped_column(String(255), nullable=False)
    upload_file_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    original_filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
    stored_filename: Mapped[str] = mapped_column(String(255), nullable=False)
    logical_filename: Mapped[str] = mapped_column(String(255), nullable=False)
    storage_key: Mapped[str] = mapped_column(String(1024), nullable=False)
    file_size_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    file_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)

    ingestion_status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")
    ingestion_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    row_count_total: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    row_count_included: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_by: Mapped[str | None] = mapped_column(String(255), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


class AnalysisBusinessRow(Base):
    __tablename__ = "analysis_business_rows"
    __table_args__ = (
        UniqueConstraint("source_file_id", "source_row_no", name="analysis_business_rows_source_row_key"),
        Index("idx_analysis_business_source_id", "source_file_id"),
        Index("idx_analysis_business_source_asin", "source_file_id", "asin"),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        primary_key=True,
        autoincrement=True,
    )
    source_file_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        ForeignKey("analysis_source_files.id", ondelete="CASCADE"),
        nullable=False,
    )
    source_row_no: Mapped[int] = mapped_column(Integer, nullable=False)
    asin: Mapped[str | None] = mapped_column(String(64), nullable=True)
    page_views: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    units_ordered: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    sessions: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    ordered_sales_amount: Mapped[Decimal] = _money_column()
    raw_row: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class AnalysisPaymentRow(Base):
    __tablename__ = "analysis_payment_rows"
    __table_args__ = (
        UniqueConstraint("source_file_id", "source_row_no", name="analysis_payment_rows_source_row_key"),
        CheckConstraint(
            "scope_status in ('included_product', 'excluded_store_level', 'excluded_unmapped')",
            name="ck_analysis_payment_scope_status",
        ),
        Index("idx_analysis_payment_source_id", "source_file_id"),
        Index("idx_analysis_payment_source_sku", "source_file_id", "sku"),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        primary_key=True,
        autoincrement=True,
    )
    source_file_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        ForeignKey("analysis_source_files.id", ondelete="CASCADE"),
        nullable=False,
    )
    source_row_no: Mapped[int] = mapped_column(Integer, nullable=False)
    transaction_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    transaction_type: Mapped[str] = mapped_column(String(64), nullable=False)
    order_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    sku: Mapped[str | None] = mapped_column(String(128), nullable=True)
    asin: Mapped[str | None] = mapped_column(String(64), nullable=True)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    product_sales: Mapped[Decimal] = _money_column()
    shipping_credits: Mapped[Decimal] = _money_column()
    promotional_rebates: Mapped[Decimal] = _money_column()
    other_amount: Mapped[Decimal] = _money_column()
    selling_fees: Mapped[Decimal] = _money_column()
    fba_fees: Mapped[Decimal] = _money_column()
    total_amount: Mapped[Decimal] = _money_column()
    scope_status: Mapped[str] = mapped_column(
        String(32), nullable=False, default="excluded_unmapped"
    )
    scope_reason: Mapped[str | None] = mapped_column(String(255), nullable=True)
    raw_row: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class AnalysisAdProductRow(Base):
    __tablename__ = "analysis_ad_product_rows"
    __table_args__ = (
        UniqueConstraint(
            "source_file_id", "source_row_no", name="analysis_ad_product_rows_source_row_key"
        ),
        CheckConstraint(
            "scope_status in ('included_product', 'excluded_store_level', 'excluded_unmapped')",
            name="ck_analysis_ad_product_scope_status",
        ),
        Index("idx_analysis_ad_product_source_id", "source_file_id"),
        Index("idx_analysis_ad_product_source_sku", "source_file_id", "sku"),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        primary_key=True,
        autoincrement=True,
    )
    source_file_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        ForeignKey("analysis_source_files.id", ondelete="CASCADE"),
        nullable=False,
    )
    source_row_no: Mapped[int] = mapped_column(Integer, nullable=False)
    sku: Mapped[str | None] = mapped_column(String(128), nullable=True)
    asin: Mapped[str | None] = mapped_column(String(64), nullable=True)
    impressions: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    clicks: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    spend: Mapped[Decimal] = _money_column()
    sales_7d: Mapped[Decimal] = _money_column()
    orders_7d: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    scope_status: Mapped[str] = mapped_column(
        String(32), nullable=False, default="excluded_unmapped"
    )
    scope_reason: Mapped[str | None] = mapped_column(String(255), nullable=True)
    raw_row: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class InventorySnapshotRow(Base):
    __tablename__ = "inventory_snapshot_rows"
    __table_args__ = (
        UniqueConstraint(
            "source_file_id", "source_row_no", name="inventory_snapshot_rows_source_row_key"
        ),
        CheckConstraint(
            "stock_status in ('in_stock', 'out_of_stock')",
            name="ck_inventory_snapshot_stock_status",
        ),
        CheckConstraint(
            "aging_status in ('fresh', 'aging', 'over_aged')",
            name="ck_inventory_snapshot_aging_status",
        ),
        Index("idx_inventory_snapshot_source_id", "source_file_id"),
        Index("idx_inventory_snapshot_source_sku", "source_file_id", "sku"),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        primary_key=True,
        autoincrement=True,
    )
    source_file_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        ForeignKey("analysis_source_files.id", ondelete="CASCADE"),
        nullable=False,
    )
    source_row_no: Mapped[int] = mapped_column(Integer, nullable=False)
    sku: Mapped[str | None] = mapped_column(String(128), nullable=True)
    asin: Mapped[str | None] = mapped_column(String(64), nullable=True)
    available_qty: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    age_0_90_qty: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    age_91_180_qty: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    age_181_270_qty: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    age_271_365_qty: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    age_365_plus_qty: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    recommended_action: Mapped[str | None] = mapped_column(String(255), nullable=True)
    stock_status: Mapped[str] = mapped_column(String(16), nullable=False)
    aging_status: Mapped[str] = mapped_column(String(16), nullable=False)
    raw_row: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


# ─── return_analysis_records ──────────────────────────────────────────────────


class ReportUploadLog(Base):
    """Records every file upload attempt for RPA status dashboard."""

    __tablename__ = "report_upload_logs"
    __table_args__ = (
        Index("idx_upload_logs_lookup", "project_id", "report_type", "country", "upload_date"),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        primary_key=True,
        autoincrement=True,
    )
    project_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
    )
    report_type: Mapped[str] = mapped_column(String(32), nullable=False)
    country: Mapped[str] = mapped_column(String(2), nullable=False, default="US")
    upload_date: Mapped[date] = mapped_column(Date(), nullable=False)
    has_real_data: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    row_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    source_file_id: Mapped[int | None] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        ForeignKey("analysis_source_files.id", ondelete="SET NULL"),
        nullable=True,
    )
    original_filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class ReturnCustomerComment(Base):
    __tablename__ = "return_customer_comments"
    __table_args__ = (
        Index("idx_customer_comments_sku_order", "sku", "order_id"),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        primary_key=True,
        autoincrement=True,
    )
    return_record_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        ForeignKey("return_analysis_records.id", ondelete="CASCADE"),
        nullable=False,
    )
    sku: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    order_id: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    customer_comment: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class AnalysisReturnRow(Base):
    __tablename__ = "analysis_return_rows"
    __table_args__ = (
        UniqueConstraint("source_file_id", "source_row_no", name="analysis_return_rows_source_row_key"),
        Index("idx_analysis_return_source_id", "source_file_id"),
        Index("idx_analysis_return_source_date", "source_file_id", "return_date"),
        Index("idx_analysis_return_sku", "sku"),
        Index("idx_analysis_return_order_id", "order_id"),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        primary_key=True,
        autoincrement=True,
    )
    source_file_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        ForeignKey("analysis_source_files.id", ondelete="CASCADE"),
        nullable=False,
    )
    source_row_no: Mapped[int] = mapped_column(Integer, nullable=False)
    return_date: Mapped[date] = mapped_column(Date(), nullable=False)
    order_id: Mapped[str] = mapped_column(String(50), nullable=False)
    sku: Mapped[str] = mapped_column(String(100), nullable=False)
    asin: Mapped[str | None] = mapped_column(String(20), nullable=True)
    fnsku: Mapped[str | None] = mapped_column(String(20), nullable=True)
    product_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    fulfillment_center_id: Mapped[str | None] = mapped_column(String(20), nullable=True)
    detailed_disposition: Mapped[str] = mapped_column(String(50), nullable=False)
    reason: Mapped[str] = mapped_column(String(100), nullable=False)
    status: Mapped[str] = mapped_column(String(100), nullable=False)
    license_plate_number: Mapped[str | None] = mapped_column(String(30), nullable=True)
    original_return_datetime: Mapped[str] = mapped_column(String(30), nullable=False)
    customer_comments: Mapped[str | None] = mapped_column(Text, nullable=True)
    raw_row: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


# ─── analysis_sales_order_rows ──────────────────────────────────────────────────


class AnalysisSalesOrderRow(Base):
    __tablename__ = "analysis_sales_order_rows"
    __table_args__ = (
        UniqueConstraint(
            "source_file_id", "source_row_no", name="analysis_sales_order_rows_source_row_key"
        ),
        Index("idx_analysis_sales_order_source_id", "source_file_id"),
        Index(
            "idx_analysis_sales_order_source_purchase_date",
            "source_file_id",
            "purchase_date_pt",
        ),
        Index("idx_analysis_sales_order_source_sku", "source_file_id", "sku"),
        Index("idx_analysis_sales_order_order_id", "amazon_order_id"),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        primary_key=True,
        autoincrement=True,
    )
    source_file_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        ForeignKey("analysis_source_files.id", ondelete="CASCADE"),
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
    quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    item_price: Mapped[Decimal] = _money_column()
    currency: Mapped[str | None] = mapped_column(String(8), nullable=True)
    is_counted_sales: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    status_rule_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    raw_row: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
