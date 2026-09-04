"""Rename factory_info to sku_factory_info

Revision ID: 20260514_120
Revises: 20260514_119
Create Date: 2026-05-14 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260514_120'
down_revision: Union[str, Sequence[str], None] = '20260514_119'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Rename factory_info columns to sku_factory_info
    op.alter_column('product_costs', 'factory_info', new_column_name='sku_factory_info')
    op.alter_column('product_costs', 'factory_info_updated_at', new_column_name='sku_factory_info_updated_at')
    op.alter_column('product_costs', 'factory_info_updated_by', new_column_name='sku_factory_info_updated_by')


def downgrade() -> None:
    # Rollback column names
    op.alter_column('product_costs', 'sku_factory_info_updated_by', new_column_name='factory_info_updated_by')
    op.alter_column('product_costs', 'sku_factory_info_updated_at', new_column_name='factory_info_updated_at')
    op.alter_column('product_costs', 'sku_factory_info', new_column_name='factory_info')