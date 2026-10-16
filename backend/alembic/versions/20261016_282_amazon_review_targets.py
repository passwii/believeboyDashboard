"""新增 Amazon 评论追踪目标、评分快照、评论、运行记录与外部关联表

Revision ID: 282
Revises: 281
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "282"
down_revision: Union[str, None] = "281"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "amazon_review_targets",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("kind", sa.String(length=20), nullable=False),
        sa.Column("group_id", sa.Integer(), nullable=True),
        sa.Column("project_id", sa.BigInteger(), nullable=True),
        sa.Column("marketplace", sa.String(length=2), nullable=False),
        sa.Column("asin", sa.String(length=20), nullable=True),
        sa.Column("display_name", sa.String(length=255), nullable=True),
        sa.Column("is_active", sa.Boolean(), server_default=sa.true(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("kind IN ('internal_group', 'external_asin')", name="ck_amazon_review_targets_kind"),
        sa.CheckConstraint(
            "(kind = 'internal_group' AND group_id IS NOT NULL AND project_id IS NOT NULL) OR "
            "(kind = 'external_asin' AND group_id IS NULL AND project_id IS NULL AND asin IS NOT NULL)",
            name="ck_amazon_review_targets_shape",
        ),
        sa.ForeignKeyConstraint(["group_id"], ["amazon_review_groups.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("group_id", name="uq_amazon_review_targets_group"),
    )
    op.create_index("idx_amazon_review_targets_kind_active", "amazon_review_targets", ["kind", "is_active"])
    op.create_index(
        "uq_amazon_review_targets_external_key", "amazon_review_targets", ["marketplace", "asin"],
        unique=True, postgresql_where=sa.text("kind = 'external_asin'"),
        sqlite_where=sa.text("kind = 'external_asin'"),
    )
    op.execute(
        """
        INSERT INTO amazon_review_targets
            (kind, group_id, project_id, marketplace, asin, display_name, is_active, created_at, updated_at)
        SELECT 'internal_group', g.id, g.project_id, g.marketplace, pc.asin, g.name, g.is_active, now(), now()
        FROM amazon_review_groups g
        LEFT JOIN product_costs pc ON pc.id = g.representative_sku_record_id
        WHERE NOT EXISTS (SELECT 1 FROM amazon_review_targets t WHERE t.group_id = g.id)
        """
    )
    op.create_table(
        "amazon_review_rating_snapshots",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("target_id", sa.Integer(), nullable=False),
        sa.Column("capture_date", sa.Date(), nullable=False),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("average_rating", sa.Numeric(precision=3, scale=2), nullable=True),
        sa.Column("rating_count", sa.Integer(), nullable=True),
        sa.Column("review_count", sa.Integer(), nullable=True),
        sa.Column("star_1_percentage", sa.Numeric(precision=5, scale=2), nullable=True),
        sa.Column("star_2_percentage", sa.Numeric(precision=5, scale=2), nullable=True),
        sa.Column("star_3_percentage", sa.Numeric(precision=5, scale=2), nullable=True),
        sa.Column("star_4_percentage", sa.Numeric(precision=5, scale=2), nullable=True),
        sa.Column("star_5_percentage", sa.Numeric(precision=5, scale=2), nullable=True),
        sa.Column("star_1_count", sa.Integer(), nullable=True),
        sa.Column("star_2_count", sa.Integer(), nullable=True),
        sa.Column("star_3_count", sa.Integer(), nullable=True),
        sa.Column("star_4_count", sa.Integer(), nullable=True),
        sa.Column("star_5_count", sa.Integer(), nullable=True),
        sa.Column("star_count_quality", sa.String(length=12), server_default="unavailable", nullable=False),
        sa.Column("capture_status", sa.String(length=16), nullable=False),
        sa.Column("source", sa.String(length=64), nullable=True),
        sa.Column("raw_payload", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["target_id"], ["amazon_review_targets.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("target_id", "capture_date", name="uq_amazon_review_rating_snapshots_target_date"),
    )
    op.create_index("idx_amazon_review_rating_snapshots_target_date", "amazon_review_rating_snapshots", ["target_id", "capture_date"])
    op.create_table(
        "amazon_review_reviews",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("target_id", sa.Integer(), nullable=False),
        sa.Column("review_key", sa.String(length=255), nullable=False),
        sa.Column("id_confidence", sa.String(length=16), nullable=False),
        sa.Column("reviewer_id", sa.String(length=128), nullable=True),
        sa.Column("reviewer_name", sa.String(length=255), nullable=True),
        sa.Column("rating", sa.Integer(), nullable=True),
        sa.Column("title", sa.String(length=512), nullable=True),
        sa.Column("body", sa.Text(), nullable=True),
        sa.Column("review_date", sa.Date(), nullable=True),
        sa.Column("verified_purchase", sa.Boolean(), nullable=True),
        sa.Column("helpful_count", sa.Integer(), nullable=True),
        sa.Column("first_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("visibility_status", sa.String(length=20), server_default="visible", nullable=False),
        sa.Column("missing_streak", sa.Integer(), server_default="0", nullable=False),
        sa.Column("raw_payload", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["target_id"], ["amazon_review_targets.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("target_id", "review_key", name="uq_amazon_review_reviews_target_key"),
    )
    op.create_index("idx_amazon_review_reviews_target_visibility", "amazon_review_reviews", ["target_id", "visibility_status"])
    op.create_index("idx_amazon_review_reviews_target_date", "amazon_review_reviews", ["target_id", "review_date"])
    op.create_table(
        "amazon_review_crawl_runs",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("target_id", sa.Integer(), nullable=False),
        sa.Column("idempotency_key", sa.String(length=128), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("is_complete_list", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("reviews_seen", sa.Integer(), nullable=True),
        sa.Column("ratings_captured", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("asin_scraped", sa.String(length=20), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["target_id"], ["amazon_review_targets.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("target_id", "idempotency_key", name="uq_amazon_review_crawl_runs_target_idem"),
    )
    op.create_index("idx_amazon_review_crawl_runs_target_started", "amazon_review_crawl_runs", ["target_id", "started_at"])
    op.create_table(
        "amazon_review_external_links",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("target_id", sa.Integer(), nullable=False),
        sa.Column("shop_id", sa.Integer(), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default=sa.true(), nullable=False),
        sa.Column("added_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("removed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["target_id"], ["amazon_review_targets.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["shop_id"], ["project_shops.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("target_id", "shop_id", name="uq_amazon_review_external_links_target_shop"),
    )
    op.create_index("idx_amazon_review_external_links_target_active", "amazon_review_external_links", ["target_id", "is_active"])
    op.create_index("idx_amazon_review_external_links_shop", "amazon_review_external_links", ["shop_id"])


def downgrade() -> None:
    op.drop_index("idx_amazon_review_external_links_shop", table_name="amazon_review_external_links")
    op.drop_index("idx_amazon_review_external_links_target_active", table_name="amazon_review_external_links")
    op.drop_table("amazon_review_external_links")
    op.drop_index("idx_amazon_review_crawl_runs_target_started", table_name="amazon_review_crawl_runs")
    op.drop_table("amazon_review_crawl_runs")
    op.drop_index("idx_amazon_review_reviews_target_date", table_name="amazon_review_reviews")
    op.drop_index("idx_amazon_review_reviews_target_visibility", table_name="amazon_review_reviews")
    op.drop_table("amazon_review_reviews")
    op.drop_index("idx_amazon_review_rating_snapshots_target_date", table_name="amazon_review_rating_snapshots")
    op.drop_table("amazon_review_rating_snapshots")
    op.drop_index("uq_amazon_review_targets_external_key", table_name="amazon_review_targets")
    op.drop_index("idx_amazon_review_targets_kind_active", table_name="amazon_review_targets")
    op.drop_table("amazon_review_targets")
