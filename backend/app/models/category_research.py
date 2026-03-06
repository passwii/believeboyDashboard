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


def _money_column() -> Mapped[Decimal | None]:
    return mapped_column(Numeric(18, 2), nullable=True)


class CategoryResearchDataset(Base):
    __tablename__ = 'category_research_datasets'
    __table_args__ = (
        UniqueConstraint(
            'marketplace',
            'category_keyword_en',
            'version',
            name='uq_category_research_marketplace_keyword_version',
        ),
        CheckConstraint('version >= 1', name='ck_category_research_version_positive'),
        CheckConstraint(
            "ingestion_status in ('pending', 'running', 'success', 'failed')",
            name='ck_category_research_ingestion_status',
        ),
        Index('idx_category_research_data_date', 'data_date'),
        Index('idx_category_research_marketplace_keyword_current', 'marketplace', 'category_keyword_en', 'is_current'),
        Index('idx_category_research_created_at', 'created_at'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        primary_key=True,
        autoincrement=True,
    )

    marketplace: Mapped[str] = mapped_column(String(16), nullable=False, server_default='US')
    category_keyword_en: Mapped[str] = mapped_column(String(255), nullable=False)
    category_name_zh: Mapped[str] = mapped_column(String(255), nullable=False)

    version: Mapped[int] = mapped_column(Integer, nullable=False, server_default='1')
    is_current: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default='false')
    superseded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    upload_file_id: Mapped[str] = mapped_column(String(255), nullable=False)
    upload_file_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    original_filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
    stored_filename: Mapped[str] = mapped_column(String(255), nullable=False)
    file_size_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    file_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)

    ingestion_status: Mapped[str] = mapped_column(String(16), nullable=False, server_default='pending')
    ingestion_error: Mapped[str | None] = mapped_column(Text, nullable=True)

    data_date: Mapped[date] = mapped_column(Date(), nullable=False, server_default=func.current_date())
    row_count_products: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    row_count_trends: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    quality_warnings: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)

    created_by: Mapped[str | None] = mapped_column(String(255), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    product_rows: Mapped[list['CategoryResearchProductDetail']] = relationship(
        back_populates='dataset',
        cascade='all, delete-orphan',
    )
    trend_rows: Mapped[list['CategoryResearchSalesTrend']] = relationship(
        back_populates='dataset',
        cascade='all, delete-orphan',
    )


class CategoryResearchProductDetail(Base):
    __tablename__ = 'category_research_product_details'
    __table_args__ = (
        UniqueConstraint('dataset_id', 'source_row_no', name='uq_category_research_product_source_row'),
        Index('idx_category_research_product_dataset_asin', 'dataset_id', 'asin'),
        Index('idx_category_research_product_dataset_brand', 'dataset_id', 'brand'),
        Index('idx_category_research_product_dataset_price', 'dataset_id', 'price_usd'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        primary_key=True,
        autoincrement=True,
    )
    dataset_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        ForeignKey('category_research_datasets.id', ondelete='CASCADE'),
        nullable=False,
    )
    source_row_no: Mapped[int] = mapped_column(Integer, nullable=False)

    asin: Mapped[str | None] = mapped_column(String(64), nullable=True)
    parent_asin: Mapped[str | None] = mapped_column(String(64), nullable=True)
    product_name: Mapped[str | None] = mapped_column(String(2048), nullable=True)
    brand: Mapped[str | None] = mapped_column(String(255), nullable=True)
    seller: Mapped[str | None] = mapped_column(String(255), nullable=True)

    price_usd: Mapped[Decimal | None] = _money_column()
    monthly_sales: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    monthly_revenue_usd: Mapped[Decimal | None] = _money_column()

    rating: Mapped[Decimal | None] = mapped_column(Numeric(10, 2), nullable=True)
    review_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')

    launch_date: Mapped[date | None] = mapped_column(Date(), nullable=True)
    listing_age_days: Mapped[int | None] = mapped_column(Integer, nullable=True)

    fba_fee_usd: Mapped[Decimal | None] = _money_column()
    fulfillment_method: Mapped[str | None] = mapped_column(String(64), nullable=True)
    bbx_seller_attribute: Mapped[str | None] = mapped_column(String(255), nullable=True)
    variant_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    has_main_image_video: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    is_climate_pledge_friendly: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    has_brand_store: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    seller_country_region: Mapped[str | None] = mapped_column(String(128), nullable=True)

    is_amazon: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default='false')
    is_new_90d: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default='false')

    extracted_dimensions: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    manual_dimensions: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    raw_row: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    dataset: Mapped[CategoryResearchDataset] = relationship(back_populates='product_rows')


class CategoryResearchSalesTrend(Base):
    __tablename__ = 'category_research_sales_trends'
    __table_args__ = (
        UniqueConstraint('dataset_id', 'asin', 'year_month', name='uq_category_research_trend_dataset_asin_month'),
        Index('idx_category_research_trend_dataset_asin', 'dataset_id', 'asin'),
        Index('idx_category_research_trend_dataset_month', 'dataset_id', 'year_month'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        primary_key=True,
        autoincrement=True,
    )
    dataset_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        ForeignKey('category_research_datasets.id', ondelete='CASCADE'),
        nullable=False,
    )

    asin: Mapped[str] = mapped_column(String(64), nullable=False)
    parent_asin: Mapped[str | None] = mapped_column(String(64), nullable=True)
    year_month: Mapped[str] = mapped_column(String(7), nullable=False)
    monthly_sales: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    dataset: Mapped[CategoryResearchDataset] = relationship(back_populates='trend_rows')
