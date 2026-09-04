"""create ad upload detail rows

Revision ID: 20260326_073
Revises: 20260326_072
Create Date: 2026-03-26 17:05:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260326_073'
down_revision: Union[str, None] = '20260326_072'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'ad_upload_campaign_rows',
        sa.Column('id', sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column('source_file_id', sa.BigInteger(), sa.ForeignKey('ad_upload_files.id', ondelete='CASCADE'), nullable=False),
        sa.Column('source_row_no', sa.Integer(), nullable=False),
        sa.Column('report_start_date', sa.Date(), nullable=False),
        sa.Column('report_end_date', sa.Date(), nullable=False),
        sa.Column('campaign_name', sa.String(length=255), nullable=True),
        sa.Column('portfolio_name', sa.String(length=255), nullable=True),
        sa.Column('campaign_type', sa.String(length=64), nullable=True),
        sa.Column('targeting_type', sa.String(length=64), nullable=True),
        sa.Column('bidding_strategy', sa.String(length=128), nullable=True),
        sa.Column('status', sa.String(length=64), nullable=True),
        sa.Column('budget', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('impressions', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('clicks', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('ctr', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('spend', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('cpc', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('orders_7d', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('sales_7d', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('acos', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('roas', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('raw_row', sa.JSON(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('now()')),
        sa.UniqueConstraint('source_file_id', 'source_row_no', name='ad_upload_campaign_rows_source_row_key'),
    )
    op.create_index('idx_ad_upload_campaign_rows_source_id', 'ad_upload_campaign_rows', ['source_file_id'])
    op.create_index('idx_ad_upload_campaign_rows_campaign', 'ad_upload_campaign_rows', ['campaign_name'])
    op.create_index('idx_ad_upload_campaign_rows_dates', 'ad_upload_campaign_rows', ['report_start_date', 'report_end_date'])

    op.create_table(
        'ad_upload_search_term_rows',
        sa.Column('id', sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column('source_file_id', sa.BigInteger(), sa.ForeignKey('ad_upload_files.id', ondelete='CASCADE'), nullable=False),
        sa.Column('source_row_no', sa.Integer(), nullable=False),
        sa.Column('report_start_date', sa.Date(), nullable=False),
        sa.Column('report_end_date', sa.Date(), nullable=False),
        sa.Column('campaign_name', sa.String(length=255), nullable=True),
        sa.Column('ad_group_name', sa.String(length=255), nullable=True),
        sa.Column('target_text', sa.Text(), nullable=True),
        sa.Column('match_type', sa.String(length=64), nullable=True),
        sa.Column('search_term', sa.Text(), nullable=True),
        sa.Column('impressions', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('clicks', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('ctr', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('spend', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('cpc', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('orders_7d', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('sales_7d', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('acos', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('roas', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('cvr_7d', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('raw_row', sa.JSON(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('now()')),
        sa.UniqueConstraint('source_file_id', 'source_row_no', name='ad_upload_search_term_rows_source_row_key'),
    )
    op.create_index('idx_ad_upload_search_term_rows_source_id', 'ad_upload_search_term_rows', ['source_file_id'])
    op.create_index('idx_ad_upload_search_term_rows_term', 'ad_upload_search_term_rows', ['search_term'])
    op.create_index('idx_ad_upload_search_term_rows_campaign', 'ad_upload_search_term_rows', ['campaign_name'])
    op.create_index('idx_ad_upload_search_term_rows_dates', 'ad_upload_search_term_rows', ['report_start_date', 'report_end_date'])

    op.create_table(
        'ad_upload_promoted_product_rows',
        sa.Column('id', sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column('source_file_id', sa.BigInteger(), sa.ForeignKey('ad_upload_files.id', ondelete='CASCADE'), nullable=False),
        sa.Column('source_row_no', sa.Integer(), nullable=False),
        sa.Column('report_start_date', sa.Date(), nullable=False),
        sa.Column('report_end_date', sa.Date(), nullable=False),
        sa.Column('campaign_name', sa.String(length=255), nullable=True),
        sa.Column('ad_group_name', sa.String(length=255), nullable=True),
        sa.Column('ad_sku', sa.String(length=128), nullable=True),
        sa.Column('ad_asin', sa.String(length=64), nullable=True),
        sa.Column('impressions', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('clicks', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('ctr', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('spend', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('cpc', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('orders_7d', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('units_7d', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('sales_7d', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('acos', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('roas', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('cvr_7d', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('ad_sku_units_7d', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('other_sku_units_7d', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('ad_sku_sales_7d', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('other_sku_sales_7d', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('raw_row', sa.JSON(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('now()')),
        sa.UniqueConstraint('source_file_id', 'source_row_no', name='ad_upload_promoted_product_rows_source_row_key'),
    )
    op.create_index('idx_ad_upload_promoted_product_rows_source_id', 'ad_upload_promoted_product_rows', ['source_file_id'])
    op.create_index('idx_ad_upload_promoted_product_rows_sku', 'ad_upload_promoted_product_rows', ['ad_sku'])
    op.create_index('idx_ad_upload_promoted_product_rows_asin', 'ad_upload_promoted_product_rows', ['ad_asin'])
    op.create_index('idx_ad_upload_promoted_product_rows_campaign', 'ad_upload_promoted_product_rows', ['campaign_name'])
    op.create_index('idx_ad_upload_promoted_product_rows_dates', 'ad_upload_promoted_product_rows', ['report_start_date', 'report_end_date'])


def downgrade() -> None:
    op.drop_index('idx_ad_upload_promoted_product_rows_dates', table_name='ad_upload_promoted_product_rows')
    op.drop_index('idx_ad_upload_promoted_product_rows_campaign', table_name='ad_upload_promoted_product_rows')
    op.drop_index('idx_ad_upload_promoted_product_rows_asin', table_name='ad_upload_promoted_product_rows')
    op.drop_index('idx_ad_upload_promoted_product_rows_sku', table_name='ad_upload_promoted_product_rows')
    op.drop_index('idx_ad_upload_promoted_product_rows_source_id', table_name='ad_upload_promoted_product_rows')
    op.drop_table('ad_upload_promoted_product_rows')

    op.drop_index('idx_ad_upload_search_term_rows_dates', table_name='ad_upload_search_term_rows')
    op.drop_index('idx_ad_upload_search_term_rows_campaign', table_name='ad_upload_search_term_rows')
    op.drop_index('idx_ad_upload_search_term_rows_term', table_name='ad_upload_search_term_rows')
    op.drop_index('idx_ad_upload_search_term_rows_source_id', table_name='ad_upload_search_term_rows')
    op.drop_table('ad_upload_search_term_rows')

    op.drop_index('idx_ad_upload_campaign_rows_dates', table_name='ad_upload_campaign_rows')
    op.drop_index('idx_ad_upload_campaign_rows_campaign', table_name='ad_upload_campaign_rows')
    op.drop_index('idx_ad_upload_campaign_rows_source_id', table_name='ad_upload_campaign_rows')
    op.drop_table('ad_upload_campaign_rows')
