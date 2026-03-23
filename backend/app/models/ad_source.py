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


def _metric_decimal(scale: int = 6) -> Mapped[Decimal]:
    return mapped_column(Numeric(18, scale), nullable=False, server_default='0')


class AdSourceFile(Base):
    __tablename__ = 'ad_source_files'
    __table_args__ = (
        UniqueConstraint(
            'project_id',
            'report_type',
            'country',
            'period_start_date',
            'period_end_date',
            'version',
            name='ad_source_files_period_version_key',
        ),
        CheckConstraint(
            (
                "report_type in ("
                "'ad_time_trend_report', "
                "'ad_campaign_report', "
                "'ad_placement_report', "
                "'ad_search_term_report', "
                "'ad_target_report', "
                "'ad_search_term_share_report', "
                "'ad_promoted_product_report', "
                "'ad_purchased_product_report', "
                "'ad_budget_report', "
                "'ad_invalid_traffic_report'"
                ")"
            ),
            name='ck_ad_source_files_report_type',
        ),
        CheckConstraint('version >= 1', name='ck_ad_source_files_version_positive'),
        CheckConstraint(
            "ingestion_status in ('pending', 'running', 'success', 'failed')",
            name='ck_ad_source_files_ingestion_status',
        ),
        CheckConstraint(
            'period_start_date is not null and period_end_date is not null and period_start_date <= period_end_date',
            name='ck_ad_source_files_period_valid',
        ),
        Index('idx_ad_source_files_project_id', 'project_id'),
        Index('idx_ad_source_files_report_type', 'report_type'),
        Index('idx_ad_source_files_country', 'country'),
        Index('idx_ad_source_files_is_current', 'is_current'),
        Index('idx_ad_source_files_ingestion_status', 'ingestion_status'),
        Index(
            'idx_ad_source_files_project_type_country_report_date',
            'project_id',
            'report_type',
            'country',
            'report_date',
        ),
        Index(
            'idx_ad_source_files_project_type_country_period',
            'project_id',
            'report_type',
            'country',
            'period_start_date',
            'period_end_date',
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
    report_type: Mapped[str] = mapped_column(String(64), nullable=False)
    country: Mapped[str] = mapped_column(String(2), nullable=False, default='US', server_default='US')
    report_date: Mapped[date | None] = mapped_column(Date(), nullable=True)
    period_start_date: Mapped[date] = mapped_column(Date(), nullable=False)
    period_end_date: Mapped[date] = mapped_column(Date(), nullable=False)
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

    time_trend_rows: Mapped[list['AdTimeTrendReportRow']] = relationship(
        back_populates='source_file',
        cascade='all, delete-orphan',
    )
    campaign_rows: Mapped[list['AdCampaignReportRow']] = relationship(
        back_populates='source_file',
        cascade='all, delete-orphan',
    )
    placement_rows: Mapped[list['AdPlacementReportRow']] = relationship(
        back_populates='source_file',
        cascade='all, delete-orphan',
    )
    search_term_rows: Mapped[list['AdSearchTermReportRow']] = relationship(
        back_populates='source_file',
        cascade='all, delete-orphan',
    )
    target_rows: Mapped[list['AdTargetReportRow']] = relationship(
        back_populates='source_file',
        cascade='all, delete-orphan',
    )
    search_term_share_rows: Mapped[list['AdSearchTermShareReportRow']] = relationship(
        back_populates='source_file',
        cascade='all, delete-orphan',
    )
    promoted_product_rows: Mapped[list['AdPromotedProductReportRow']] = relationship(
        back_populates='source_file',
        cascade='all, delete-orphan',
    )
    purchased_product_rows: Mapped[list['AdPurchasedProductReportRow']] = relationship(
        back_populates='source_file',
        cascade='all, delete-orphan',
    )
    budget_rows: Mapped[list['AdBudgetReportRow']] = relationship(
        back_populates='source_file',
        cascade='all, delete-orphan',
    )
    invalid_traffic_rows: Mapped[list['AdInvalidTrafficReportRow']] = relationship(
        back_populates='source_file',
        cascade='all, delete-orphan',
    )


class AdTimeTrendReportRow(Base):
    __tablename__ = 'ad_time_trend_report_rows'
    __table_args__ = (
        UniqueConstraint('source_file_id', 'source_row_no', name='ad_time_trend_report_rows_source_row_key'),
        Index('idx_ad_time_trend_source_id', 'source_file_id'),
        Index('idx_ad_time_trend_dates', 'source_file_id', 'report_start_date', 'report_end_date'),
    )

    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, 'sqlite'), primary_key=True, autoincrement=True)
    source_file_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        ForeignKey('ad_source_files.id', ondelete='CASCADE'),
        nullable=False,
    )
    source_row_no: Mapped[int] = mapped_column(Integer, nullable=False)
    report_start_date: Mapped[date] = mapped_column(Date(), nullable=False)
    report_end_date: Mapped[date] = mapped_column(Date(), nullable=False)
    country: Mapped[str | None] = mapped_column(String(2), nullable=True)
    currency: Mapped[str | None] = mapped_column(String(8), nullable=True)
    clicks: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    cpc: Mapped[Decimal] = _metric_decimal()
    spend: Mapped[Decimal] = _metric_decimal()
    raw_row: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    source_file: Mapped[AdSourceFile] = relationship(back_populates='time_trend_rows')


class AdCampaignReportRow(Base):
    __tablename__ = 'ad_campaign_report_rows'
    __table_args__ = (
        UniqueConstraint('source_file_id', 'source_row_no', name='ad_campaign_report_rows_source_row_key'),
        Index('idx_ad_campaign_source_id', 'source_file_id'),
        Index('idx_ad_campaign_dates', 'source_file_id', 'report_start_date', 'report_end_date'),
        Index('idx_ad_campaign_name', 'source_file_id', 'campaign_name'),
        Index('idx_ad_campaign_status', 'source_file_id', 'status'),
    )

    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, 'sqlite'), primary_key=True, autoincrement=True)
    source_file_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        ForeignKey('ad_source_files.id', ondelete='CASCADE'),
        nullable=False,
    )
    source_row_no: Mapped[int] = mapped_column(Integer, nullable=False)
    report_start_date: Mapped[date] = mapped_column(Date(), nullable=False)
    report_end_date: Mapped[date] = mapped_column(Date(), nullable=False)
    portfolio_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    campaign_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    campaign_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    retailer: Mapped[str | None] = mapped_column(String(64), nullable=True)
    country: Mapped[str | None] = mapped_column(String(2), nullable=True)
    status: Mapped[str | None] = mapped_column(String(64), nullable=True)
    currency: Mapped[str | None] = mapped_column(String(8), nullable=True)
    budget: Mapped[Decimal] = _metric_decimal()
    targeting_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    bidding_strategy: Mapped[str | None] = mapped_column(String(128), nullable=True)
    impressions: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    impressions_last_year: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    clicks: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    clicks_last_year: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    ctr: Mapped[Decimal] = _metric_decimal()
    spend: Mapped[Decimal] = _metric_decimal()
    spend_last_year: Mapped[Decimal] = _metric_decimal()
    cpc: Mapped[Decimal] = _metric_decimal()
    cpc_last_year: Mapped[Decimal] = _metric_decimal()
    orders_7d: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    acos: Mapped[Decimal] = _metric_decimal()
    roas: Mapped[Decimal] = _metric_decimal()
    sales_7d: Mapped[Decimal] = _metric_decimal()
    raw_row: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    source_file: Mapped[AdSourceFile] = relationship(back_populates='campaign_rows')


class AdPlacementReportRow(Base):
    __tablename__ = 'ad_placement_report_rows'
    __table_args__ = (
        UniqueConstraint('source_file_id', 'source_row_no', name='ad_placement_report_rows_source_row_key'),
        Index('idx_ad_placement_source_id', 'source_file_id'),
        Index('idx_ad_placement_dates', 'source_file_id', 'report_start_date', 'report_end_date'),
        Index('idx_ad_placement_campaign', 'source_file_id', 'campaign_name'),
        Index('idx_ad_placement_name', 'source_file_id', 'placement'),
    )

    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, 'sqlite'), primary_key=True, autoincrement=True)
    source_file_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        ForeignKey('ad_source_files.id', ondelete='CASCADE'),
        nullable=False,
    )
    source_row_no: Mapped[int] = mapped_column(Integer, nullable=False)
    report_start_date: Mapped[date] = mapped_column(Date(), nullable=False)
    report_end_date: Mapped[date] = mapped_column(Date(), nullable=False)
    portfolio_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    currency: Mapped[str | None] = mapped_column(String(8), nullable=True)
    campaign_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    retailer: Mapped[str | None] = mapped_column(String(64), nullable=True)
    country: Mapped[str | None] = mapped_column(String(2), nullable=True)
    bidding_strategy: Mapped[str | None] = mapped_column(String(128), nullable=True)
    placement: Mapped[str | None] = mapped_column(String(255), nullable=True)
    impressions: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    clicks: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    cpc: Mapped[Decimal] = _metric_decimal()
    spend: Mapped[Decimal] = _metric_decimal()
    sales_7d: Mapped[Decimal] = _metric_decimal()
    acos: Mapped[Decimal] = _metric_decimal()
    roas: Mapped[Decimal] = _metric_decimal()
    orders_7d: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    units_7d: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    raw_row: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    source_file: Mapped[AdSourceFile] = relationship(back_populates='placement_rows')


class AdSearchTermReportRow(Base):
    __tablename__ = 'ad_search_term_report_rows'
    __table_args__ = (
        UniqueConstraint('source_file_id', 'source_row_no', name='ad_search_term_report_rows_source_row_key'),
        Index('idx_ad_search_term_source_id', 'source_file_id'),
        Index('idx_ad_search_term_dates', 'source_file_id', 'report_start_date', 'report_end_date'),
        Index('idx_ad_search_term_campaign', 'source_file_id', 'campaign_name'),
        Index('idx_ad_search_term_group', 'source_file_id', 'ad_group_name'),
        Index('idx_ad_search_term_term', 'source_file_id', 'search_term'),
        Index('idx_ad_search_term_target', 'source_file_id', 'target_text'),
    )

    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, 'sqlite'), primary_key=True, autoincrement=True)
    source_file_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        ForeignKey('ad_source_files.id', ondelete='CASCADE'),
        nullable=False,
    )
    source_row_no: Mapped[int] = mapped_column(Integer, nullable=False)
    report_start_date: Mapped[date] = mapped_column(Date(), nullable=False)
    report_end_date: Mapped[date] = mapped_column(Date(), nullable=False)
    portfolio_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    currency: Mapped[str | None] = mapped_column(String(8), nullable=True)
    campaign_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    ad_group_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    retailer: Mapped[str | None] = mapped_column(String(64), nullable=True)
    country: Mapped[str | None] = mapped_column(String(2), nullable=True)
    target_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    match_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    search_term: Mapped[str | None] = mapped_column(Text, nullable=True)
    impressions: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    clicks: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    ctr: Mapped[Decimal] = _metric_decimal()
    cpc: Mapped[Decimal] = _metric_decimal()
    spend: Mapped[Decimal] = _metric_decimal()
    sales_7d: Mapped[Decimal] = _metric_decimal()
    acos: Mapped[Decimal] = _metric_decimal()
    roas: Mapped[Decimal] = _metric_decimal()
    orders_7d: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    units_7d: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    cvr_7d: Mapped[Decimal] = _metric_decimal()
    ad_sku_units_7d: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    other_sku_units_7d: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    ad_sku_sales_7d: Mapped[Decimal] = _metric_decimal()
    other_sku_sales_7d: Mapped[Decimal] = _metric_decimal()
    raw_row: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    source_file: Mapped[AdSourceFile] = relationship(back_populates='search_term_rows')


class AdTargetReportRow(Base):
    __tablename__ = 'ad_target_report_rows'
    __table_args__ = (
        UniqueConstraint('source_file_id', 'source_row_no', name='ad_target_report_rows_source_row_key'),
        Index('idx_ad_target_source_id', 'source_file_id'),
        Index('idx_ad_target_dates', 'source_file_id', 'report_start_date', 'report_end_date'),
        Index('idx_ad_target_campaign', 'source_file_id', 'campaign_name'),
        Index('idx_ad_target_group', 'source_file_id', 'ad_group_name'),
        Index('idx_ad_target_text', 'source_file_id', 'target_text'),
    )

    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, 'sqlite'), primary_key=True, autoincrement=True)
    source_file_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        ForeignKey('ad_source_files.id', ondelete='CASCADE'),
        nullable=False,
    )
    source_row_no: Mapped[int] = mapped_column(Integer, nullable=False)
    report_start_date: Mapped[date] = mapped_column(Date(), nullable=False)
    report_end_date: Mapped[date] = mapped_column(Date(), nullable=False)
    portfolio_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    currency: Mapped[str | None] = mapped_column(String(8), nullable=True)
    campaign_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    country: Mapped[str | None] = mapped_column(String(2), nullable=True)
    ad_group_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    retailer: Mapped[str | None] = mapped_column(String(64), nullable=True)
    target_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    match_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    impressions: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    top_of_search_impression_share: Mapped[Decimal] = _metric_decimal()
    clicks: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    ctr: Mapped[Decimal] = _metric_decimal()
    cpc: Mapped[Decimal] = _metric_decimal()
    spend: Mapped[Decimal] = _metric_decimal()
    acos: Mapped[Decimal] = _metric_decimal()
    roas: Mapped[Decimal] = _metric_decimal()
    sales_7d: Mapped[Decimal] = _metric_decimal()
    orders_7d: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    units_7d: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    cvr_7d: Mapped[Decimal] = _metric_decimal()
    ad_sku_units_7d: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    other_sku_units_7d: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    ad_sku_sales_7d: Mapped[Decimal] = _metric_decimal()
    other_sku_sales_7d: Mapped[Decimal] = _metric_decimal()
    raw_row: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    source_file: Mapped[AdSourceFile] = relationship(back_populates='target_rows')


class AdSearchTermShareReportRow(Base):
    __tablename__ = 'ad_search_term_share_report_rows'
    __table_args__ = (
        UniqueConstraint('source_file_id', 'source_row_no', name='ad_search_term_share_report_rows_source_row_key'),
        Index('idx_ad_search_term_share_source_id', 'source_file_id'),
        Index('idx_ad_search_term_share_dates', 'source_file_id', 'report_start_date', 'report_end_date'),
        Index('idx_ad_search_term_share_term', 'source_file_id', 'search_term'),
        Index('idx_ad_search_term_share_campaign', 'source_file_id', 'campaign_name'),
    )

    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, 'sqlite'), primary_key=True, autoincrement=True)
    source_file_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        ForeignKey('ad_source_files.id', ondelete='CASCADE'),
        nullable=False,
    )
    source_row_no: Mapped[int] = mapped_column(Integer, nullable=False)
    report_start_date: Mapped[date] = mapped_column(Date(), nullable=False)
    report_end_date: Mapped[date] = mapped_column(Date(), nullable=False)
    country: Mapped[str | None] = mapped_column(String(2), nullable=True)
    search_term: Mapped[str | None] = mapped_column(Text, nullable=True)
    impression_share_rank: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    impression_share: Mapped[Decimal] = _metric_decimal()
    target_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    match_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    portfolio_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    campaign_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    ad_group_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    currency: Mapped[str | None] = mapped_column(String(8), nullable=True)
    clicks: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    impressions: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    ctr: Mapped[Decimal] = _metric_decimal()
    spend: Mapped[Decimal] = _metric_decimal()
    cpc: Mapped[Decimal] = _metric_decimal()
    orders_7d: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    sales_7d: Mapped[Decimal] = _metric_decimal()
    acos: Mapped[Decimal] = _metric_decimal()
    roas: Mapped[Decimal] = _metric_decimal()
    cvr_7d: Mapped[Decimal] = _metric_decimal()
    raw_row: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    source_file: Mapped[AdSourceFile] = relationship(back_populates='search_term_share_rows')


class AdPromotedProductReportRow(Base):
    __tablename__ = 'ad_promoted_product_report_rows'
    __table_args__ = (
        UniqueConstraint('source_file_id', 'source_row_no', name='ad_promoted_product_report_rows_source_row_key'),
        Index('idx_ad_promoted_product_source_id', 'source_file_id'),
        Index('idx_ad_promoted_product_dates', 'source_file_id', 'report_start_date', 'report_end_date'),
        Index('idx_ad_promoted_product_campaign', 'source_file_id', 'campaign_name'),
        Index('idx_ad_promoted_product_group', 'source_file_id', 'ad_group_name'),
        Index('idx_ad_promoted_product_sku', 'source_file_id', 'ad_sku'),
        Index('idx_ad_promoted_product_asin', 'source_file_id', 'ad_asin'),
    )

    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, 'sqlite'), primary_key=True, autoincrement=True)
    source_file_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        ForeignKey('ad_source_files.id', ondelete='CASCADE'),
        nullable=False,
    )
    source_row_no: Mapped[int] = mapped_column(Integer, nullable=False)
    report_start_date: Mapped[date] = mapped_column(Date(), nullable=False)
    report_end_date: Mapped[date] = mapped_column(Date(), nullable=False)
    portfolio_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    currency: Mapped[str | None] = mapped_column(String(8), nullable=True)
    campaign_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    ad_group_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    retailer: Mapped[str | None] = mapped_column(String(64), nullable=True)
    country: Mapped[str | None] = mapped_column(String(2), nullable=True)
    ad_sku: Mapped[str | None] = mapped_column(String(128), nullable=True)
    ad_asin: Mapped[str | None] = mapped_column(String(64), nullable=True)
    impressions: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    clicks: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    ctr: Mapped[Decimal] = _metric_decimal()
    cpc: Mapped[Decimal] = _metric_decimal()
    spend: Mapped[Decimal] = _metric_decimal()
    sales_7d: Mapped[Decimal] = _metric_decimal()
    acos: Mapped[Decimal] = _metric_decimal()
    roas: Mapped[Decimal] = _metric_decimal()
    orders_7d: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    units_7d: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    cvr_7d: Mapped[Decimal] = _metric_decimal()
    ad_sku_units_7d: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    other_sku_units_7d: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    ad_sku_sales_7d: Mapped[Decimal] = _metric_decimal()
    other_sku_sales_7d: Mapped[Decimal] = _metric_decimal()
    raw_row: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    source_file: Mapped[AdSourceFile] = relationship(back_populates='promoted_product_rows')


class AdPurchasedProductReportRow(Base):
    __tablename__ = 'ad_purchased_product_report_rows'
    __table_args__ = (
        UniqueConstraint('source_file_id', 'source_row_no', name='ad_purchased_product_report_rows_source_row_key'),
        Index('idx_ad_purchased_product_source_id', 'source_file_id'),
        Index('idx_ad_purchased_product_dates', 'source_file_id', 'report_start_date', 'report_end_date'),
        Index('idx_ad_purchased_product_campaign', 'source_file_id', 'campaign_name'),
        Index('idx_ad_purchased_product_sku', 'source_file_id', 'ad_sku'),
        Index('idx_ad_purchased_product_purchased_asin', 'source_file_id', 'purchased_asin'),
    )

    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, 'sqlite'), primary_key=True, autoincrement=True)
    source_file_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        ForeignKey('ad_source_files.id', ondelete='CASCADE'),
        nullable=False,
    )
    source_row_no: Mapped[int] = mapped_column(Integer, nullable=False)
    report_start_date: Mapped[date] = mapped_column(Date(), nullable=False)
    report_end_date: Mapped[date] = mapped_column(Date(), nullable=False)
    portfolio_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    campaign_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    country: Mapped[str | None] = mapped_column(String(2), nullable=True)
    currency: Mapped[str | None] = mapped_column(String(8), nullable=True)
    ad_group_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    retailer: Mapped[str | None] = mapped_column(String(64), nullable=True)
    ad_sku: Mapped[str | None] = mapped_column(String(128), nullable=True)
    ad_asin: Mapped[str | None] = mapped_column(String(64), nullable=True)
    target_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    match_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    purchased_asin: Mapped[str | None] = mapped_column(String(64), nullable=True)
    other_sku_units_7d: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    other_sku_orders_7d: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    other_sku_sales_7d: Mapped[Decimal] = _metric_decimal()
    raw_row: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    source_file: Mapped[AdSourceFile] = relationship(back_populates='purchased_product_rows')


class AdBudgetReportRow(Base):
    __tablename__ = 'ad_budget_report_rows'
    __table_args__ = (
        UniqueConstraint('source_file_id', 'source_row_no', name='ad_budget_report_rows_source_row_key'),
        Index('idx_ad_budget_source_id', 'source_file_id'),
        Index('idx_ad_budget_dates', 'source_file_id', 'report_start_date', 'report_end_date'),
        Index('idx_ad_budget_campaign', 'source_file_id', 'campaign_name'),
        Index('idx_ad_budget_status', 'source_file_id', 'status'),
    )

    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, 'sqlite'), primary_key=True, autoincrement=True)
    source_file_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        ForeignKey('ad_source_files.id', ondelete='CASCADE'),
        nullable=False,
    )
    source_row_no: Mapped[int] = mapped_column(Integer, nullable=False)
    report_start_date: Mapped[date] = mapped_column(Date(), nullable=False)
    report_end_date: Mapped[date] = mapped_column(Date(), nullable=False)
    portfolio_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    campaign_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    campaign_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    country: Mapped[str | None] = mapped_column(String(2), nullable=True)
    status: Mapped[str | None] = mapped_column(String(64), nullable=True)
    currency: Mapped[str | None] = mapped_column(String(8), nullable=True)
    budget: Mapped[Decimal] = _metric_decimal()
    suggested_budget: Mapped[Decimal] = _metric_decimal()
    avg_time_in_budget: Mapped[Decimal] = _metric_decimal()
    targeting_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    bidding_strategy: Mapped[str | None] = mapped_column(String(128), nullable=True)
    impressions: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    impressions_last_year: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    lost_impressions_min: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    lost_impressions_max: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    clicks: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    clicks_last_year: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    lost_clicks_min: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    lost_clicks_max: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    ctr: Mapped[Decimal] = _metric_decimal()
    spend: Mapped[Decimal] = _metric_decimal()
    spend_last_year: Mapped[Decimal] = _metric_decimal()
    cpc: Mapped[Decimal] = _metric_decimal()
    cpc_last_year: Mapped[Decimal] = _metric_decimal()
    orders_7d: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    acos: Mapped[Decimal] = _metric_decimal()
    roas: Mapped[Decimal] = _metric_decimal()
    sales_7d: Mapped[Decimal] = _metric_decimal()
    lost_sales_min: Mapped[Decimal] = _metric_decimal()
    lost_sales_max: Mapped[Decimal] = _metric_decimal()
    raw_row: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    source_file: Mapped[AdSourceFile] = relationship(back_populates='budget_rows')


class AdInvalidTrafficReportRow(Base):
    __tablename__ = 'ad_invalid_traffic_report_rows'
    __table_args__ = (
        UniqueConstraint('source_file_id', 'source_row_no', name='ad_invalid_traffic_report_rows_source_row_key'),
        Index('idx_ad_invalid_traffic_source_id', 'source_file_id'),
        Index('idx_ad_invalid_traffic_dates', 'source_file_id', 'report_start_date', 'report_end_date'),
        Index('idx_ad_invalid_traffic_campaign', 'source_file_id', 'campaign_name'),
        Index('idx_ad_invalid_traffic_status', 'source_file_id', 'status'),
    )

    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, 'sqlite'), primary_key=True, autoincrement=True)
    source_file_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        ForeignKey('ad_source_files.id', ondelete='CASCADE'),
        nullable=False,
    )
    source_row_no: Mapped[int] = mapped_column(Integer, nullable=False)
    report_start_date: Mapped[date] = mapped_column(Date(), nullable=False)
    report_end_date: Mapped[date] = mapped_column(Date(), nullable=False)
    campaign_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    retailer: Mapped[str | None] = mapped_column(String(64), nullable=True)
    country: Mapped[str | None] = mapped_column(String(2), nullable=True)
    status: Mapped[str | None] = mapped_column(String(64), nullable=True)
    total_impressions: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    impressions: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    invalid_impressions: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    invalid_impression_rate: Mapped[Decimal] = _metric_decimal()
    total_clicks: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    clicks: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    invalid_clicks: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    invalid_click_rate: Mapped[Decimal] = _metric_decimal()
    raw_row: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    source_file: Mapped[AdSourceFile] = relationship(back_populates='invalid_traffic_rows')
