"""add missing product detail fields to category research

Revision ID: 20260306_027
Revises: 20260306_026
Create Date: 2026-03-06 20:10:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260306_027'
down_revision: Union[str, None] = '20260306_026'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(inspector: sa.Inspector, table_name: str) -> bool:
    return table_name in inspector.get_table_names()


def _has_column(inspector: sa.Inspector, table_name: str, column_name: str) -> bool:
    return any(column.get('name') == column_name for column in inspector.get_columns(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    table_name = 'category_research_product_details'

    if _has_table(inspector, table_name) is False:
        return

    additions = [
        ('bbx_seller_attribute', sa.Column('bbx_seller_attribute', sa.String(length=255), nullable=True)),
        ('variant_count', sa.Column('variant_count', sa.Integer(), nullable=True)),
        ('has_main_image_video', sa.Column('has_main_image_video', sa.Boolean(), nullable=True)),
        ('is_climate_pledge_friendly', sa.Column('is_climate_pledge_friendly', sa.Boolean(), nullable=True)),
        ('has_brand_store', sa.Column('has_brand_store', sa.Boolean(), nullable=True)),
        ('seller_country_region', sa.Column('seller_country_region', sa.String(length=128), nullable=True)),
    ]

    for column_name, column in additions:
        if _has_column(inspector, table_name, column_name) is False:
            op.add_column(table_name, column)
            inspector = sa.inspect(bind)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    table_name = 'category_research_product_details'

    if _has_table(inspector, table_name) is False:
        return

    for column_name in [
        'seller_country_region',
        'has_brand_store',
        'is_climate_pledge_friendly',
        'has_main_image_video',
        'variant_count',
        'bbx_seller_attribute',
    ]:
        if _has_column(inspector, table_name, column_name):
            op.drop_column(table_name, column_name)
            inspector = sa.inspect(bind)
