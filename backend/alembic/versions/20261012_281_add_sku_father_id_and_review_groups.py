"""新增 Father ID 与内部 Amazon 评论共享组关系表

Revision ID: 281
Revises: 280
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "281"
down_revision: Union[str, None] = "280"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    # father_id belongs to Task 1, not revision 281. Create it for clean
    # revision-280 schemas, but preserve it on downgrade in either case.
    existing_columns = {column["name"] for column in sa.inspect(bind).get_columns("product_costs")}
    if "father_id" not in existing_columns:
        op.add_column("product_costs", sa.Column("father_id", sa.String(), nullable=True))
    existing_constraints = {
        constraint["name"]
        for constraint in sa.inspect(bind).get_unique_constraints("product_costs")
    }
    if "uq_product_costs_id_project_country" not in existing_constraints:
        with op.batch_alter_table("product_costs") as batch_op:
            batch_op.create_unique_constraint(
                "uq_product_costs_id_project_country", ["id", "project_id", "country"]
            )
    op.create_table(
        "amazon_review_groups",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("project_id", sa.BigInteger(), nullable=False),
        sa.Column("marketplace", sa.String(length=2), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("representative_sku_record_id", sa.BigInteger(), nullable=True),
        sa.Column("is_active", sa.Boolean(), server_default=sa.true(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(
            ["representative_sku_record_id", "project_id", "marketplace"],
            ["product_costs.id", "product_costs.project_id", "product_costs.country"],
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("id", "project_id", "marketplace", name="uq_amazon_review_groups_member_ref"),
    )
    op.create_index("idx_amazon_review_groups_scope_active", "amazon_review_groups", ["project_id", "marketplace", "is_active"])
    op.create_table(
        "amazon_review_group_members",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("group_id", sa.Integer(), nullable=False),
        sa.Column("project_id", sa.BigInteger(), nullable=False),
        sa.Column("marketplace", sa.String(length=2), nullable=False),
        sa.Column("sku_record_id", sa.BigInteger(), nullable=False),
        sa.Column("added_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("removed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(
            ["group_id", "project_id", "marketplace"],
            ["amazon_review_groups.id", "amazon_review_groups.project_id", "amazon_review_groups.marketplace"],
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["sku_record_id", "project_id", "marketplace"],
            ["product_costs.id", "product_costs.project_id", "product_costs.country"],
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "uq_amazon_review_group_members_active_sku",
        "amazon_review_group_members",
        ["sku_record_id"],
        unique=True,
        postgresql_where=sa.text("removed_at IS NULL"),
        sqlite_where=sa.text("removed_at IS NULL"),
    )
    op.create_index("idx_amazon_review_group_members_group_active", "amazon_review_group_members", ["group_id", "removed_at"])
    op.create_index("idx_amazon_review_group_members_sku", "amazon_review_group_members", ["sku_record_id"])


def downgrade() -> None:
    bind = op.get_bind()
    op.drop_index("idx_amazon_review_group_members_sku", table_name="amazon_review_group_members")
    op.drop_index("idx_amazon_review_group_members_group_active", table_name="amazon_review_group_members")
    op.drop_index("uq_amazon_review_group_members_active_sku", table_name="amazon_review_group_members")
    op.drop_table("amazon_review_group_members")
    op.drop_index("idx_amazon_review_groups_scope_active", table_name="amazon_review_groups")
    op.drop_table("amazon_review_groups")
    existing_constraints = {
        constraint["name"]
        for constraint in sa.inspect(bind).get_unique_constraints("product_costs")
    }
    if "uq_product_costs_id_project_country" in existing_constraints:
        with op.batch_alter_table("product_costs") as batch_op:
            batch_op.drop_constraint("uq_product_costs_id_project_country", type_="unique")
    # father_id is a Task 1 feature column; downgrade deliberately preserves it.
