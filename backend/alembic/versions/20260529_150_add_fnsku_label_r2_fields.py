"""add fnsku label r2 fields to product_costs

Revision ID: 150
Revises: 149
Create Date: 2026-05-29
"""

from alembic import op
import sqlalchemy as sa

revision = "150"
down_revision = "149"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "product_costs",
        sa.Column("fnsku_label_r2_key", sa.String(512), nullable=True),
    )
    op.add_column(
        "product_costs",
        sa.Column("fnsku_label_r2_url", sa.String(1024), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("product_costs", "fnsku_label_r2_url")
    op.drop_column("product_costs", "fnsku_label_r2_key")
