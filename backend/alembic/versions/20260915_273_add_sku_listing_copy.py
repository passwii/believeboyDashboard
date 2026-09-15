"""SKU 产品文案列：标题/五点描述/Description/卖点（BLF-1080）

Revision ID: 273
Revises: 272
Create Date: 2026-09-15 00:00:00.000000

`product_costs` 新增亚马逊 Listing 文案字段组，作为 SKU Info 主数据的一部分
（前端「产品文案」Tab，docs/superpowers/specs/2026-09-15-sku-listing-copy-design.md）。
全部可空、无 server_default、**不做回填**——存量行 NULL 语义即「未录入文案」。
bullet 拆 5 列（而非 JSON）以便导出成列 + 单点校验（spec §2.2）。
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = '273'
down_revision: str | None = '272'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('product_costs', sa.Column('listing_title', sa.String(length=500), nullable=True))
    op.add_column('product_costs', sa.Column('listing_bullet_1', sa.Text(), nullable=True))
    op.add_column('product_costs', sa.Column('listing_bullet_2', sa.Text(), nullable=True))
    op.add_column('product_costs', sa.Column('listing_bullet_3', sa.Text(), nullable=True))
    op.add_column('product_costs', sa.Column('listing_bullet_4', sa.Text(), nullable=True))
    op.add_column('product_costs', sa.Column('listing_bullet_5', sa.Text(), nullable=True))
    op.add_column('product_costs', sa.Column('listing_description', sa.Text(), nullable=True))
    op.add_column('product_costs', sa.Column('listing_selling_points', sa.Text(), nullable=True))
    op.add_column(
        'product_costs',
        sa.Column('listing_copy_updated_at', sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        'product_costs',
        sa.Column('listing_copy_updated_by', sa.String(length=128), nullable=True),
    )


def downgrade() -> None:
    op.drop_column('product_costs', 'listing_copy_updated_by')
    op.drop_column('product_costs', 'listing_copy_updated_at')
    op.drop_column('product_costs', 'listing_selling_points')
    op.drop_column('product_costs', 'listing_description')
    op.drop_column('product_costs', 'listing_bullet_5')
    op.drop_column('product_costs', 'listing_bullet_4')
    op.drop_column('product_costs', 'listing_bullet_3')
    op.drop_column('product_costs', 'listing_bullet_2')
    op.drop_column('product_costs', 'listing_bullet_1')
    op.drop_column('product_costs', 'listing_title')
