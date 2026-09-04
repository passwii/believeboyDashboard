"""add_carrier_tracking_to_sales_order_rows

Revision ID: 20260627_200
Revises: 20260624_169
Create Date: 2026-06-27

新增列：carrier / tracking_no / shipped_at / updated_by / updated_at
供 FBM 订单补录物流信息使用。
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = '20260627_200'
down_revision = '20260624_169'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        'analysis_sales_order_rows',
        sa.Column('carrier', sa.String(length=64), nullable=True),
    )
    op.add_column(
        'analysis_sales_order_rows',
        sa.Column('tracking_no', sa.String(length=128), nullable=True),
    )
    op.add_column(
        'analysis_sales_order_rows',
        sa.Column('shipped_at', sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        'analysis_sales_order_rows',
        sa.Column('updated_by', sa.String(length=64), nullable=True),
    )
    op.add_column(
        'analysis_sales_order_rows',
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        'ix_analysis_sales_order_tracking_no',
        'analysis_sales_order_rows',
        ['tracking_no'],
    )


def downgrade() -> None:
    op.drop_index('ix_analysis_sales_order_tracking_no', table_name='analysis_sales_order_rows')
    op.drop_column('analysis_sales_order_rows', 'updated_at')
    op.drop_column('analysis_sales_order_rows', 'updated_by')
    op.drop_column('analysis_sales_order_rows', 'shipped_at')
    op.drop_column('analysis_sales_order_rows', 'tracking_no')
    op.drop_column('analysis_sales_order_rows', 'carrier')