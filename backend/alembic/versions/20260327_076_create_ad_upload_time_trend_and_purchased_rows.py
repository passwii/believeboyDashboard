"""create ad upload time trend and purchased rows

Revision ID: 20260327_076
Revises: 20260326_075
Create Date: 2026-03-27 10:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260327_076'
down_revision: Union[str, None] = '20260326_075'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'ad_upload_time_trend_rows',
        sa.Column('id', sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column('source_file_id', sa.BigInteger(), sa.ForeignKey('ad_upload_files.id', ondelete='CASCADE'), nullable=False),
        sa.Column('source_row_no', sa.Integer(), nullable=False),
        sa.Column('report_start_date', sa.Date(), nullable=False),
        sa.Column('report_end_date', sa.Date(), nullable=False),
        sa.Column('country', sa.String(length=2), nullable=True),
        sa.Column('currency', sa.String(length=8), nullable=True),
        sa.Column('clicks', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('cpc', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('spend', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('raw_row', sa.JSON(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('now()')),
        sa.UniqueConstraint('source_file_id', 'source_row_no', name='ad_upload_time_trend_rows_source_row_key'),
    )
    op.create_index('idx_ad_upload_time_trend_rows_source_id', 'ad_upload_time_trend_rows', ['source_file_id'])
    op.create_index('idx_ad_upload_time_trend_rows_dates', 'ad_upload_time_trend_rows', ['report_start_date', 'report_end_date'])

    op.create_table(
        'ad_upload_purchased_product_rows',
        sa.Column('id', sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column('source_file_id', sa.BigInteger(), sa.ForeignKey('ad_upload_files.id', ondelete='CASCADE'), nullable=False),
        sa.Column('source_row_no', sa.Integer(), nullable=False),
        sa.Column('report_start_date', sa.Date(), nullable=False),
        sa.Column('report_end_date', sa.Date(), nullable=False),
        sa.Column('campaign_name', sa.String(length=255), nullable=True),
        sa.Column('ad_group_name', sa.String(length=255), nullable=True),
        sa.Column('ad_sku', sa.String(length=128), nullable=True),
        sa.Column('ad_asin', sa.String(length=64), nullable=True),
        sa.Column('target_text', sa.Text(), nullable=True),
        sa.Column('match_type', sa.String(length=64), nullable=True),
        sa.Column('purchased_asin', sa.String(length=64), nullable=True),
        sa.Column('other_sku_units_7d', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('other_sku_orders_7d', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('other_sku_sales_7d', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('raw_row', sa.JSON(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('now()')),
        sa.UniqueConstraint('source_file_id', 'source_row_no', name='ad_upload_purchased_product_rows_source_row_key'),
    )
    op.create_index('idx_ad_upload_purchased_product_rows_source_id', 'ad_upload_purchased_product_rows', ['source_file_id'])
    op.create_index('idx_ad_upload_purchased_product_rows_campaign', 'ad_upload_purchased_product_rows', ['campaign_name'])
    op.create_index('idx_ad_upload_purchased_product_rows_sku', 'ad_upload_purchased_product_rows', ['ad_sku'])
    op.create_index('idx_ad_upload_purchased_product_rows_purchased_asin', 'ad_upload_purchased_product_rows', ['purchased_asin'])
    op.create_index('idx_ad_upload_purchased_product_rows_dates', 'ad_upload_purchased_product_rows', ['report_start_date', 'report_end_date'])


def downgrade() -> None:
    op.drop_index('idx_ad_upload_purchased_product_rows_dates', table_name='ad_upload_purchased_product_rows')
    op.drop_index('idx_ad_upload_purchased_product_rows_purchased_asin', table_name='ad_upload_purchased_product_rows')
    op.drop_index('idx_ad_upload_purchased_product_rows_sku', table_name='ad_upload_purchased_product_rows')
    op.drop_index('idx_ad_upload_purchased_product_rows_campaign', table_name='ad_upload_purchased_product_rows')
    op.drop_index('idx_ad_upload_purchased_product_rows_source_id', table_name='ad_upload_purchased_product_rows')
    op.drop_table('ad_upload_purchased_product_rows')

    op.drop_index('idx_ad_upload_time_trend_rows_dates', table_name='ad_upload_time_trend_rows')
    op.drop_index('idx_ad_upload_time_trend_rows_source_id', table_name='ad_upload_time_trend_rows')
    op.drop_table('ad_upload_time_trend_rows')
