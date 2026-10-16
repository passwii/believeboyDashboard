from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    JSON,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class AmazonReviewGroup(Base):
    __tablename__ = "amazon_review_groups"
    __table_args__ = (
        UniqueConstraint(
            "id", "project_id", "marketplace",
            name="uq_amazon_review_groups_member_ref",
        ),
        ForeignKeyConstraint(
            ["representative_sku_record_id", "project_id", "marketplace"],
            ["product_costs.id", "product_costs.project_id", "product_costs.country"],
            ondelete="RESTRICT",
        ),
        Index("idx_amazon_review_groups_scope_active", "project_id", "marketplace", "is_active"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("projects.id", ondelete="RESTRICT"), nullable=False)
    marketplace: Mapped[str] = mapped_column(String(2), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    representative_sku_record_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class AmazonReviewGroupMember(Base):
    __tablename__ = "amazon_review_group_members"
    __table_args__ = (
        ForeignKeyConstraint(
            ["group_id", "project_id", "marketplace"],
            ["amazon_review_groups.id", "amazon_review_groups.project_id", "amazon_review_groups.marketplace"],
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["sku_record_id", "project_id", "marketplace"],
            ["product_costs.id", "product_costs.project_id", "product_costs.country"],
            ondelete="RESTRICT",
        ),
        Index(
            "uq_amazon_review_group_members_active_sku",
            "sku_record_id",
            unique=True,
            postgresql_where=text("removed_at IS NULL"),
            sqlite_where=text("removed_at IS NULL"),
        ),
        Index("idx_amazon_review_group_members_group_active", "group_id", "removed_at"),
        Index("idx_amazon_review_group_members_sku", "sku_record_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    group_id: Mapped[int] = mapped_column(Integer, nullable=False)
    project_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    marketplace: Mapped[str] = mapped_column(String(2), nullable=False)
    sku_record_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    removed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class AmazonReviewTarget(Base):
    __tablename__ = "amazon_review_targets"
    __table_args__ = (
        CheckConstraint("kind IN ('internal_group', 'external_asin')", name="ck_amazon_review_targets_kind"),
        CheckConstraint(
            "(kind = 'internal_group' AND group_id IS NOT NULL AND project_id IS NOT NULL) OR "
            "(kind = 'external_asin' AND group_id IS NULL AND project_id IS NULL AND asin IS NOT NULL)",
            name="ck_amazon_review_targets_shape",
        ),
        UniqueConstraint("group_id", name="uq_amazon_review_targets_group"),
        Index("idx_amazon_review_targets_kind_active", "kind", "is_active"),
        Index(
            "uq_amazon_review_targets_external_key", "marketplace", "asin",
            unique=True,
            postgresql_where=text("kind = 'external_asin'"),
            sqlite_where=text("kind = 'external_asin'"),
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    group_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("amazon_review_groups.id", ondelete="RESTRICT"), nullable=True
    )
    project_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("projects.id", ondelete="RESTRICT"), nullable=True
    )
    marketplace: Mapped[str] = mapped_column(String(2), nullable=False)
    asin: Mapped[str | None] = mapped_column(String(20), nullable=True)
    display_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class AmazonReviewRatingSnapshot(Base):
    __tablename__ = "amazon_review_rating_snapshots"
    __table_args__ = (
        UniqueConstraint("target_id", "capture_date", name="uq_amazon_review_rating_snapshots_target_date"),
        Index("idx_amazon_review_rating_snapshots_target_date", "target_id", "capture_date"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    target_id: Mapped[int] = mapped_column(Integer, ForeignKey("amazon_review_targets.id", ondelete="RESTRICT"), nullable=False)
    capture_date: Mapped[date] = mapped_column(Date, nullable=False)
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    average_rating: Mapped[Decimal | None] = mapped_column(Numeric(3, 2), nullable=True)
    rating_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    review_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    star_1_percentage: Mapped[Decimal | None] = mapped_column(Numeric(5, 2), nullable=True)
    star_2_percentage: Mapped[Decimal | None] = mapped_column(Numeric(5, 2), nullable=True)
    star_3_percentage: Mapped[Decimal | None] = mapped_column(Numeric(5, 2), nullable=True)
    star_4_percentage: Mapped[Decimal | None] = mapped_column(Numeric(5, 2), nullable=True)
    star_5_percentage: Mapped[Decimal | None] = mapped_column(Numeric(5, 2), nullable=True)
    star_1_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    star_2_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    star_3_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    star_4_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    star_5_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    star_count_quality: Mapped[str] = mapped_column(String(12), nullable=False, server_default="unavailable")
    capture_status: Mapped[str] = mapped_column(String(16), nullable=False)
    source: Mapped[str | None] = mapped_column(String(64), nullable=True)
    raw_payload: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class AmazonReviewReview(Base):
    __tablename__ = "amazon_review_reviews"
    __table_args__ = (
        UniqueConstraint("target_id", "review_key", name="uq_amazon_review_reviews_target_key"),
        Index("idx_amazon_review_reviews_target_visibility", "target_id", "visibility_status"),
        Index("idx_amazon_review_reviews_target_date", "target_id", "review_date"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    target_id: Mapped[int] = mapped_column(Integer, ForeignKey("amazon_review_targets.id", ondelete="RESTRICT"), nullable=False)
    review_key: Mapped[str] = mapped_column(String(255), nullable=False)
    id_confidence: Mapped[str] = mapped_column(String(16), nullable=False)
    reviewer_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    reviewer_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    rating: Mapped[int | None] = mapped_column(Integer, nullable=True)
    title: Mapped[str | None] = mapped_column(String(512), nullable=True)
    body: Mapped[str | None] = mapped_column(Text, nullable=True)
    review_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    verified_purchase: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    helpful_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    visibility_status: Mapped[str] = mapped_column(String(20), nullable=False, server_default="visible")
    missing_streak: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    raw_payload: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class AmazonReviewCrawlRun(Base):
    __tablename__ = "amazon_review_crawl_runs"
    __table_args__ = (
        UniqueConstraint("target_id", "idempotency_key", name="uq_amazon_review_crawl_runs_target_idem"),
        Index("idx_amazon_review_crawl_runs_target_started", "target_id", "started_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    target_id: Mapped[int] = mapped_column(Integer, ForeignKey("amazon_review_targets.id", ondelete="RESTRICT"), nullable=False)
    idempotency_key: Mapped[str | None] = mapped_column(String(128), nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    is_complete_list: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    reviews_seen: Mapped[int | None] = mapped_column(Integer, nullable=True)
    ratings_captured: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    asin_scraped: Mapped[str | None] = mapped_column(String(20), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class AmazonReviewExternalLink(Base):
    __tablename__ = "amazon_review_external_links"
    __table_args__ = (
        UniqueConstraint("target_id", "shop_id", name="uq_amazon_review_external_links_target_shop"),
        Index("idx_amazon_review_external_links_target_active", "target_id", "is_active"),
        Index("idx_amazon_review_external_links_shop", "shop_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    target_id: Mapped[int] = mapped_column(Integer, ForeignKey("amazon_review_targets.id", ondelete="RESTRICT"), nullable=False)
    shop_id: Mapped[int] = mapped_column(Integer, ForeignKey("project_shops.id", ondelete="RESTRICT"), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    removed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
