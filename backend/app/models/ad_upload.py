from __future__ import annotations

from datetime import date, datetime

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
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class AdUploadFile(Base):
    __tablename__ = 'ad_upload_files'
    __table_args__ = (
        UniqueConstraint(
            'project_id',
            'report_type',
            'country',
            'period_start_date',
            'period_end_date',
            'version',
            name='ad_upload_files_scope_version_key',
        ),
        CheckConstraint(
            (
                "report_type in ("
                "'ad_time_trend_report', "
                "'ad_campaign_report', "
                "'ad_budget_report', "
                "'ad_placement_report', "
                "'ad_invalid_traffic_report', "
                "'ad_search_term_report', "
                "'ad_target_report', "
                "'ad_search_term_share_report', "
                "'ad_promoted_product_report', "
                "'ad_purchased_product_report'"
                ")"
            ),
            name='ck_ad_upload_files_report_type',
        ),
        CheckConstraint(
            "recognition_status in ('recognized', 'unsupported', 'error')",
            name='ck_ad_upload_files_recognition_status',
        ),
        CheckConstraint(
            "ingestion_status in ('pending', 'saved', 'failed')",
            name='ck_ad_upload_files_ingestion_status',
        ),
        CheckConstraint('version >= 1', name='ck_ad_upload_files_version_positive'),
        CheckConstraint(
            'period_start_date <= period_end_date',
            name='ck_ad_upload_files_period_valid',
        ),
        Index('idx_ad_upload_files_project_id', 'project_id'),
        Index('idx_ad_upload_files_report_type', 'report_type'),
        Index('idx_ad_upload_files_country', 'country'),
        Index('idx_ad_upload_files_report_date', 'report_date'),
        Index('idx_ad_upload_files_is_current', 'is_current'),
        Index('idx_ad_upload_files_updated_at', 'updated_at'),
        Index(
            'idx_ad_upload_files_project_scope',
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
    project_name: Mapped[str] = mapped_column(String(255), nullable=False)
    report_type: Mapped[str] = mapped_column(String(64), nullable=False)
    report_label: Mapped[str] = mapped_column(String(255), nullable=False)
    country: Mapped[str] = mapped_column(String(2), nullable=False, default='US', server_default='US')
    report_date: Mapped[date | None] = mapped_column(Date(), nullable=True)
    period_start_date: Mapped[date] = mapped_column(Date(), nullable=False)
    period_end_date: Mapped[date] = mapped_column(Date(), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False, server_default='1')
    is_current: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default='true')
    superseded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    upload_file_id: Mapped[str] = mapped_column(String(255), nullable=False)
    upload_file_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    original_filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
    stored_filename: Mapped[str] = mapped_column(String(255), nullable=False)
    logical_filename: Mapped[str] = mapped_column(String(255), nullable=False)
    file_extension: Mapped[str] = mapped_column(String(16), nullable=False)
    file_size_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)

    recognition_status: Mapped[str] = mapped_column(String(16), nullable=False, server_default='recognized')
    ingestion_status: Mapped[str] = mapped_column(String(16), nullable=False, server_default='pending')
    ingestion_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    row_count_preview: Mapped[int | None] = mapped_column(Integer, nullable=True)
    matched_columns: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    warnings: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    recognition_payload: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_by: Mapped[str | None] = mapped_column(String(255), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


class AdUploadCampaignRow(Base):
    __tablename__ = 'ad_upload_campaign_rows'
    __table_args__ = (
        UniqueConstraint('source_file_id', 'source_row_no', name='ad_upload_campaign_rows_source_row_key'),
        Index('idx_ad_upload_campaign_rows_source_id', 'source_file_id'),
        Index('idx_ad_upload_campaign_rows_campaign', 'campaign_name'),
        Index('idx_ad_upload_campaign_rows_dates', 'report_start_date', 'report_end_date'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        primary_key=True,
        autoincrement=True,
    )
    source_file_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        ForeignKey('ad_upload_files.id', ondelete='CASCADE'),
        nullable=False,
    )
    source_row_no: Mapped[int] = mapped_column(Integer, nullable=False)
    report_start_date: Mapped[date] = mapped_column(Date(), nullable=False)
    report_end_date: Mapped[date] = mapped_column(Date(), nullable=False)
    campaign_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    portfolio_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    campaign_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    targeting_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    bidding_strategy: Mapped[str | None] = mapped_column(String(128), nullable=True)
    status: Mapped[str | None] = mapped_column(String(64), nullable=True)
    budget: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    impressions: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    clicks: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    ctr: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    spend: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    cpc: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    orders_7d: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    sales_7d: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    acos: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    roas: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    raw_row: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class AdUploadSearchTermRow(Base):
    __tablename__ = 'ad_upload_search_term_rows'
    __table_args__ = (
        UniqueConstraint('source_file_id', 'source_row_no', name='ad_upload_search_term_rows_source_row_key'),
        Index('idx_ad_upload_search_term_rows_source_id', 'source_file_id'),
        Index('idx_ad_upload_search_term_rows_term', 'search_term'),
        Index('idx_ad_upload_search_term_rows_campaign', 'campaign_name'),
        Index('idx_ad_upload_search_term_rows_dates', 'report_start_date', 'report_end_date'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        primary_key=True,
        autoincrement=True,
    )
    source_file_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        ForeignKey('ad_upload_files.id', ondelete='CASCADE'),
        nullable=False,
    )
    source_row_no: Mapped[int] = mapped_column(Integer, nullable=False)
    report_start_date: Mapped[date] = mapped_column(Date(), nullable=False)
    report_end_date: Mapped[date] = mapped_column(Date(), nullable=False)
    campaign_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    ad_group_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    target_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    match_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    search_term: Mapped[str | None] = mapped_column(Text, nullable=True)
    impressions: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    clicks: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    ctr: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    spend: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    cpc: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    orders_7d: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    sales_7d: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    acos: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    roas: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    cvr_7d: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    raw_row: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class AdUploadPromotedProductRow(Base):
    __tablename__ = 'ad_upload_promoted_product_rows'
    __table_args__ = (
        UniqueConstraint('source_file_id', 'source_row_no', name='ad_upload_promoted_product_rows_source_row_key'),
        Index('idx_ad_upload_promoted_product_rows_source_id', 'source_file_id'),
        Index('idx_ad_upload_promoted_product_rows_sku', 'ad_sku'),
        Index('idx_ad_upload_promoted_product_rows_asin', 'ad_asin'),
        Index('idx_ad_upload_promoted_product_rows_campaign', 'campaign_name'),
        Index('idx_ad_upload_promoted_product_rows_dates', 'report_start_date', 'report_end_date'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        primary_key=True,
        autoincrement=True,
    )
    source_file_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        ForeignKey('ad_upload_files.id', ondelete='CASCADE'),
        nullable=False,
    )
    source_row_no: Mapped[int] = mapped_column(Integer, nullable=False)
    report_start_date: Mapped[date] = mapped_column(Date(), nullable=False)
    report_end_date: Mapped[date] = mapped_column(Date(), nullable=False)
    campaign_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    ad_group_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    ad_sku: Mapped[str | None] = mapped_column(String(128), nullable=True)
    ad_asin: Mapped[str | None] = mapped_column(String(64), nullable=True)
    impressions: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    clicks: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    ctr: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    spend: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    cpc: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    orders_7d: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    units_7d: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    sales_7d: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    acos: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    roas: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    cvr_7d: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    ad_sku_units_7d: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    other_sku_units_7d: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    ad_sku_sales_7d: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    other_sku_sales_7d: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    raw_row: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class AdUploadTargetRow(Base):
    __tablename__ = 'ad_upload_target_rows'
    __table_args__ = (
        UniqueConstraint('source_file_id', 'source_row_no', name='ad_upload_target_rows_source_row_key'),
        Index('idx_ad_upload_target_rows_source_id', 'source_file_id'),
        Index('idx_ad_upload_target_rows_campaign', 'campaign_name'),
        Index('idx_ad_upload_target_rows_target', 'target_text'),
        Index('idx_ad_upload_target_rows_dates', 'report_start_date', 'report_end_date'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        primary_key=True,
        autoincrement=True,
    )
    source_file_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        ForeignKey('ad_upload_files.id', ondelete='CASCADE'),
        nullable=False,
    )
    source_row_no: Mapped[int] = mapped_column(Integer, nullable=False)
    report_start_date: Mapped[date] = mapped_column(Date(), nullable=False)
    report_end_date: Mapped[date] = mapped_column(Date(), nullable=False)
    campaign_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    ad_group_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    target_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    match_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    impressions: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    top_of_search_impression_share: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    clicks: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    ctr: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    cpc: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    spend: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    sales_7d: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    orders_7d: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    units_7d: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    acos: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    roas: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    cvr_7d: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    raw_row: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class AdUploadSearchTermShareRow(Base):
    __tablename__ = 'ad_upload_search_term_share_rows'
    __table_args__ = (
        UniqueConstraint('source_file_id', 'source_row_no', name='ad_upload_search_term_share_rows_source_row_key'),
        Index('idx_ad_upload_search_term_share_rows_source_id', 'source_file_id'),
        Index('idx_ad_upload_search_term_share_rows_term', 'search_term'),
        Index('idx_ad_upload_search_term_share_rows_campaign', 'campaign_name'),
        Index('idx_ad_upload_search_term_share_rows_dates', 'report_start_date', 'report_end_date'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        primary_key=True,
        autoincrement=True,
    )
    source_file_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        ForeignKey('ad_upload_files.id', ondelete='CASCADE'),
        nullable=False,
    )
    source_row_no: Mapped[int] = mapped_column(Integer, nullable=False)
    report_start_date: Mapped[date] = mapped_column(Date(), nullable=False)
    report_end_date: Mapped[date] = mapped_column(Date(), nullable=False)
    search_term: Mapped[str | None] = mapped_column(Text, nullable=True)
    impression_rank: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    impression_share: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    target_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    match_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    campaign_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    ad_group_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    clicks: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    impressions: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    ctr: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    spend: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    cpc: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    orders_7d: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    sales_7d: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    acos: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    roas: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    cvr_7d: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    raw_row: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class AdUploadTimeTrendRow(Base):
    __tablename__ = 'ad_upload_time_trend_rows'
    __table_args__ = (
        UniqueConstraint('source_file_id', 'source_row_no', name='ad_upload_time_trend_rows_source_row_key'),
        Index('idx_ad_upload_time_trend_rows_source_id', 'source_file_id'),
        Index('idx_ad_upload_time_trend_rows_dates', 'report_start_date', 'report_end_date'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        primary_key=True,
        autoincrement=True,
    )
    source_file_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        ForeignKey('ad_upload_files.id', ondelete='CASCADE'),
        nullable=False,
    )
    source_row_no: Mapped[int] = mapped_column(Integer, nullable=False)
    report_start_date: Mapped[date] = mapped_column(Date(), nullable=False)
    report_end_date: Mapped[date] = mapped_column(Date(), nullable=False)
    country: Mapped[str | None] = mapped_column(String(2), nullable=True)
    currency: Mapped[str | None] = mapped_column(String(8), nullable=True)
    clicks: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    cpc: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    spend: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    raw_row: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class AdUploadPurchasedProductRow(Base):
    __tablename__ = 'ad_upload_purchased_product_rows'
    __table_args__ = (
        UniqueConstraint('source_file_id', 'source_row_no', name='ad_upload_purchased_product_rows_source_row_key'),
        Index('idx_ad_upload_purchased_product_rows_source_id', 'source_file_id'),
        Index('idx_ad_upload_purchased_product_rows_campaign', 'campaign_name'),
        Index('idx_ad_upload_purchased_product_rows_sku', 'ad_sku'),
        Index('idx_ad_upload_purchased_product_rows_purchased_asin', 'purchased_asin'),
        Index('idx_ad_upload_purchased_product_rows_dates', 'report_start_date', 'report_end_date'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        primary_key=True,
        autoincrement=True,
    )
    source_file_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        ForeignKey('ad_upload_files.id', ondelete='CASCADE'),
        nullable=False,
    )
    source_row_no: Mapped[int] = mapped_column(Integer, nullable=False)
    report_start_date: Mapped[date] = mapped_column(Date(), nullable=False)
    report_end_date: Mapped[date] = mapped_column(Date(), nullable=False)
    campaign_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    ad_group_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    ad_sku: Mapped[str | None] = mapped_column(String(128), nullable=True)
    ad_asin: Mapped[str | None] = mapped_column(String(64), nullable=True)
    target_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    match_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    purchased_asin: Mapped[str | None] = mapped_column(String(64), nullable=True)
    other_sku_units_7d: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    other_sku_orders_7d: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    other_sku_sales_7d: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    raw_row: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class AdUploadBudgetRow(Base):
    __tablename__ = 'ad_upload_budget_rows'
    __table_args__ = (
        UniqueConstraint('source_file_id', 'source_row_no', name='ad_upload_budget_rows_source_row_key'),
        Index('idx_ad_upload_budget_rows_source_id', 'source_file_id'),
        Index('idx_ad_upload_budget_rows_campaign', 'campaign_name'),
        Index('idx_ad_upload_budget_rows_dates', 'report_start_date', 'report_end_date'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        primary_key=True,
        autoincrement=True,
    )
    source_file_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        ForeignKey('ad_upload_files.id', ondelete='CASCADE'),
        nullable=False,
    )
    source_row_no: Mapped[int] = mapped_column(Integer, nullable=False)
    report_start_date: Mapped[date] = mapped_column(Date(), nullable=False)
    report_end_date: Mapped[date] = mapped_column(Date(), nullable=False)
    campaign_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    status: Mapped[str | None] = mapped_column(String(64), nullable=True)
    budget: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    suggested_budget: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    budget_utilization_rate: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    missed_impressions_min: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    missed_impressions_max: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    missed_clicks_min: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    missed_clicks_max: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    missed_sales_min: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    missed_sales_max: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    spend: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    sales_7d: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    orders_7d: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    acos: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    raw_row: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class AdUploadPlacementRow(Base):
    __tablename__ = 'ad_upload_placement_rows'
    __table_args__ = (
        UniqueConstraint('source_file_id', 'source_row_no', name='ad_upload_placement_rows_source_row_key'),
        Index('idx_ad_upload_placement_rows_source_id', 'source_file_id'),
        Index('idx_ad_upload_placement_rows_campaign', 'campaign_name'),
        Index('idx_ad_upload_placement_rows_placement', 'placement'),
        Index('idx_ad_upload_placement_rows_dates', 'report_start_date', 'report_end_date'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        primary_key=True,
        autoincrement=True,
    )
    source_file_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        ForeignKey('ad_upload_files.id', ondelete='CASCADE'),
        nullable=False,
    )
    source_row_no: Mapped[int] = mapped_column(Integer, nullable=False)
    report_start_date: Mapped[date] = mapped_column(Date(), nullable=False)
    report_end_date: Mapped[date] = mapped_column(Date(), nullable=False)
    campaign_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    placement: Mapped[str | None] = mapped_column(String(255), nullable=True)
    bidding_strategy: Mapped[str | None] = mapped_column(String(128), nullable=True)
    impressions: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    clicks: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    spend: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    cpc: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    sales_7d: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    orders_7d: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    units_7d: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    acos: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    roas: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    raw_row: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class AdUploadInvalidTrafficRow(Base):
    __tablename__ = 'ad_upload_invalid_traffic_rows'
    __table_args__ = (
        UniqueConstraint('source_file_id', 'source_row_no', name='ad_upload_invalid_traffic_rows_source_row_key'),
        Index('idx_ad_upload_invalid_traffic_rows_source_id', 'source_file_id'),
        Index('idx_ad_upload_invalid_traffic_rows_campaign', 'campaign_name'),
        Index('idx_ad_upload_invalid_traffic_rows_dates', 'report_start_date', 'report_end_date'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        primary_key=True,
        autoincrement=True,
    )
    source_file_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        ForeignKey('ad_upload_files.id', ondelete='CASCADE'),
        nullable=False,
    )
    source_row_no: Mapped[int] = mapped_column(Integer, nullable=False)
    report_start_date: Mapped[date] = mapped_column(Date(), nullable=False)
    report_end_date: Mapped[date] = mapped_column(Date(), nullable=False)
    campaign_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    status: Mapped[str | None] = mapped_column(String(64), nullable=True)
    total_impressions: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    valid_impressions: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    invalid_impressions: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    invalid_impression_rate: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    total_clicks: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    valid_clicks: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    invalid_clicks: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    invalid_click_rate: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False, server_default='0')
    raw_row: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
