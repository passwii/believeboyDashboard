"""
SQLAlchemy models for the auto-report-upload service.

Analysis models (AnalysisSourceFile, Analysis*Row, InventorySnapshotRow) are
imported from ``backend/app/models/`` — the Alembic-managed single source of
truth.  Local models (Project, ProductCost, ReportUploadLog,
ReturnCustomerComment) remain here because they are RPA-specific convenience
models that are NOT used by the upload pipeline (which writes analysis rows).
"""

from __future__ import annotations

import sys
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

# ── Add backend to path so we can import app.models / app.db.session ──────
_BACKEND_PATH = Path(__file__).resolve().parent.parent / "backend"
if str(_BACKEND_PATH) not in sys.path:
    sys.path.insert(0, str(_BACKEND_PATH))

# Use backend's Base so all ORM models share one Alembic-tracked metadata
from app.db.session import Base  # noqa: E402

# Import shared analysis models from the canonical source (Alembic-managed)
from app.models import (  # noqa: E402
    AnalysisAdProductRow,
    AnalysisBusinessRow,
    AnalysisPaymentRow,
    AnalysisReturnRow,
    AnalysisSalesOrderRow,
    AnalysisSourceFile,
    InventorySnapshotRow,
)


# ─── projects ────────────────────────────────────────────────────────────────


class Project(Base):
    __tablename__ = "projects"
    __table_args__ = (
        UniqueConstraint("project_name", name="projects_project_name_key"),
        CheckConstraint("sort_order >= 0", name="projects_sort_order_check"),
    )

    id: Mapped[int] = mapped_column(
        BigInteger(),
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


# ─── product_costs ───────────────────────────────────────────────────────────


class ProductCost(Base):
    __tablename__ = "product_costs"
    __table_args__ = (
        UniqueConstraint(
            "project_id",
            "sku",
            "asin",
            "country",
            name="product_costs_project_id_sku_asin_country_key",
        ),
        Index("idx_product_costs_project_id", "project_id"),
        Index("idx_product_costs_project_sort", "project_id", "sort_order", "id"),
        Index("idx_product_costs_project_sku_active", "project_id", "sku", "is_active"),
    )

    id: Mapped[int] = mapped_column(
        BigInteger(),
        primary_key=True,
        autoincrement=True,
    )
    project_id: Mapped[int] = mapped_column(
        BigInteger(),
        ForeignKey("projects.id", ondelete="RESTRICT"),
        nullable=False,
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


# ─── report_upload_logs ──────────────────────────────────────────────────────


class ReportUploadLog(Base):
    """Records every file upload attempt for RPA status dashboard."""

    __tablename__ = "report_upload_logs"
    __table_args__ = (
        Index("idx_upload_logs_lookup", "project_id", "report_type", "country", "upload_date"),
    )

    id: Mapped[int] = mapped_column(
        BigInteger(),
        primary_key=True,
        autoincrement=True,
    )
    project_id: Mapped[int] = mapped_column(
        BigInteger(),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
    )
    report_type: Mapped[str] = mapped_column(String(32), nullable=False)
    country: Mapped[str] = mapped_column(String(2), nullable=False, default="US")
    upload_date: Mapped[date] = mapped_column(Date(), nullable=False)
    has_real_data: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    row_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    source_file_id: Mapped[int | None] = mapped_column(
        BigInteger(),
        ForeignKey("analysis_source_files.id", ondelete="SET NULL"),
        nullable=True,
    )
    original_filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


# ─── return_customer_comments ────────────────────────────────────────────────


class ReturnCustomerComment(Base):
    __tablename__ = "return_customer_comments"
    __table_args__ = (
        Index("idx_customer_comments_sku_order", "sku", "order_id"),
    )

    id: Mapped[int] = mapped_column(
        BigInteger(),
        primary_key=True,
        autoincrement=True,
    )
    return_record_id: Mapped[int] = mapped_column(
        BigInteger(),
        ForeignKey("return_analysis_records.id", ondelete="CASCADE"),
        nullable=False,
    )
    sku: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    order_id: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    customer_comment: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
