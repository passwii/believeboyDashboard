"""add project sku active index to product_costs

Revision ID: 20260308_031
Revises: 20260308_030
Create Date: 2026-03-08 22:10:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260308_031'
down_revision: Union[str, None] = '20260308_030'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(inspector: sa.Inspector, table_name: str) -> bool:
    return table_name in inspector.get_table_names()


def _has_index(inspector: sa.Inspector, table_name: str, index_name: str) -> bool:
    return any(idx.get('name') == index_name for idx in inspector.get_indexes(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if _has_table(inspector, 'product_costs') is False:
        return

    if _has_index(inspector, 'product_costs', 'idx_product_costs_project_sku_active') is False:
        op.create_index(
            'idx_product_costs_project_sku_active',
            'product_costs',
            ['project_name', 'sku', 'is_active'],
            unique=False,
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if _has_table(inspector, 'product_costs') is False:
        return

    if _has_index(inspector, 'product_costs', 'idx_product_costs_project_sku_active'):
        op.drop_index('idx_product_costs_project_sku_active', table_name='product_costs')
