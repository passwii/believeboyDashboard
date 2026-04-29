"""add_shipping_price_to_sales_order_rows

Revision ID: 20260429_111
Revises: 20260428_110
Create Date: 2026-04-29

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = '20260429_111'
down_revision = '20260428_110'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        'analysis_sales_order_rows',
        sa.Column('shipping_price', sa.Numeric(18, 2), nullable=False, server_default='0'),
    )


def downgrade() -> None:
    op.drop_column('analysis_sales_order_rows', 'shipping_price')
