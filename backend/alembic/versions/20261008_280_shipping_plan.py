"""建立发货规划数据模型

Revision ID: 280
Revises: 279
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "280"
down_revision: Union[str, None] = "279"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "shipping_plan_sku_settings",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("project_id", sa.BigInteger(), nullable=False),
        sa.Column("country", sa.String(length=2), nullable=False),
        sa.Column("sku", sa.String(length=128), nullable=False),
        sa.Column("growth_factor", sa.Numeric(precision=8, scale=4), server_default="1.0", nullable=False),
        sa.Column("created_by", sa.String(length=255), nullable=True),
        sa.Column("updated_by", sa.String(length=255), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("growth_factor >= 0", name="ck_shipping_plan_sku_settings_growth_factor_non_negative"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("project_id", "country", "sku", name="uq_shipping_plan_sku_settings_scope"),
    )
    op.create_index(
        "idx_shipping_plan_sku_settings_project_country",
        "shipping_plan_sku_settings",
        ["project_id", "country"],
    )

    op.create_table(
        "shipping_plan_batches",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("project_id", sa.BigInteger(), nullable=False),
        sa.Column("country", sa.String(length=2), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("expected_arrival_date", sa.Date(), nullable=False),
        sa.Column("status", sa.String(length=16), server_default="active", nullable=False),
        sa.Column("remark", sa.Text(), nullable=True),
        sa.Column("created_by", sa.String(length=255), nullable=True),
        sa.Column("updated_by", sa.String(length=255), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("status in ('active', 'cancelled')", name="ck_shipping_plan_batches_status"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "idx_shipping_plan_batches_project_country",
        "shipping_plan_batches",
        ["project_id", "country"],
    )
    op.create_index(
        "idx_shipping_plan_batches_status_arrival",
        "shipping_plan_batches",
        ["status", "expected_arrival_date"],
    )

    op.create_table(
        "shipping_plan_items",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("batch_id", sa.Integer(), nullable=False),
        sa.Column("sku", sa.String(length=128), nullable=False),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.CheckConstraint("quantity > 0", name="ck_shipping_plan_items_quantity_positive"),
        sa.ForeignKeyConstraint(["batch_id"], ["shipping_plan_batches.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("batch_id", "sku", name="uq_shipping_plan_items_batch_sku"),
    )
    op.create_index("idx_shipping_plan_items_sku", "shipping_plan_items", ["sku"])

    op.create_table(
        "shipping_plan_allocations",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("plan_item_id", sa.Integer(), nullable=False),
        sa.Column("shipment_schedule_id", sa.BigInteger(), nullable=False),
        sa.Column("sku", sa.String(length=128), nullable=False),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.CheckConstraint("quantity > 0", name="ck_shipping_plan_allocations_quantity_positive"),
        sa.ForeignKeyConstraint(["plan_item_id"], ["shipping_plan_items.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["shipment_schedule_id"], ["shipment_schedules.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("plan_item_id", "shipment_schedule_id", name="uq_shipping_plan_allocations_item_schedule"),
    )
    op.create_index(
        "idx_shipping_plan_allocations_schedule_sku",
        "shipping_plan_allocations",
        ["shipment_schedule_id", "sku"],
    )


def downgrade() -> None:
    op.drop_index("idx_shipping_plan_allocations_schedule_sku", table_name="shipping_plan_allocations")
    op.drop_table("shipping_plan_allocations")
    op.drop_index("idx_shipping_plan_items_sku", table_name="shipping_plan_items")
    op.drop_table("shipping_plan_items")
    op.drop_index("idx_shipping_plan_batches_status_arrival", table_name="shipping_plan_batches")
    op.drop_index("idx_shipping_plan_batches_project_country", table_name="shipping_plan_batches")
    op.drop_table("shipping_plan_batches")
    op.drop_index("idx_shipping_plan_sku_settings_project_country", table_name="shipping_plan_sku_settings")
    op.drop_table("shipping_plan_sku_settings")
