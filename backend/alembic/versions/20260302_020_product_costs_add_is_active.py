"""add is_active to product_costs

Revision ID: 20260302_020
Revises: 20260302_019
Create Date: 2026-03-02 23:55:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260302_020'
down_revision: Union[str, None] = '20260302_019'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(inspector: sa.Inspector, table_name: str) -> bool:
    return table_name in inspector.get_table_names()


def _has_column(inspector: sa.Inspector, table_name: str, column_name: str) -> bool:
    return any(col['name'] == column_name for col in inspector.get_columns(table_name))


def _has_index(inspector: sa.Inspector, table_name: str, index_name: str) -> bool:
    return any(idx.get('name') == index_name for idx in inspector.get_indexes(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if _has_table(inspector, 'product_costs') is False:
        return

    if _has_column(inspector, 'product_costs', 'is_active') is False:
        op.add_column(
            'product_costs',
            sa.Column('is_active', sa.Boolean(), nullable=False, server_default=sa.text('true')),
        )

    inspector = sa.inspect(bind)
    if _has_index(inspector, 'product_costs', 'idx_product_costs_is_active') is False:
        op.create_index('idx_product_costs_is_active', 'product_costs', ['is_active'], unique=False)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if _has_table(inspector, 'product_costs') is False:
        return

    if _has_index(inspector, 'product_costs', 'idx_product_costs_is_active'):
        op.drop_index('idx_product_costs_is_active', table_name='product_costs')

    inspector = sa.inspect(bind)
    if _has_column(inspector, 'product_costs', 'is_active'):
        op.drop_column('product_costs', 'is_active')
