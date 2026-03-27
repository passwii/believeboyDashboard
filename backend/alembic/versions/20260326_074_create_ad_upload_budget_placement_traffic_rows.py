"""create ad upload budget placement traffic rows

Revision ID: 20260326_074
Revises: 20260326_073
Create Date: 2026-03-26 18:20:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260326_074'
down_revision: Union[str, None] = '20260326_073'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'ad_upload_budget_rows',
        sa.Column('id', sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column('source_file_id', sa.BigInteger(), sa.ForeignKey('ad_upload_files.id', ondelete='CASCADE'), nullable=False),
        sa.Column('source_row_no', sa.Integer(), nullable=False),
        sa.Column('report_start_date', sa.Date(), nullable=False),
        sa.Column('report_end_date', sa.Date(), nullable=False),
        sa.Column('campaign_name', sa.String(length=255), nullable=True),
        sa.Column('status', sa.String(length=64), nullable=True),
        sa.Column('budget', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('suggested_budget', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('budget_utilization_rate', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('missed_impressions_min', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('missed_impressions_max', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('missed_clicks_min', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('missed_clicks_max', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('missed_sales_min', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('missed_sales_max', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('spend', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('sales_7d', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('orders_7d', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('acos', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('raw_row', sa.JSON(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('now()')),
        sa.UniqueConstraint('source_file_id', 'source_row_no', name='ad_upload_budget_rows_source_row_key'),
    )
    op.create_index('idx_ad_upload_budget_rows_source_id', 'ad_upload_budget_rows', ['source_file_id'])
    op.create_index('idx_ad_upload_budget_rows_campaign', 'ad_upload_budget_rows', ['campaign_name'])
    op.create_index('idx_ad_upload_budget_rows_dates', 'ad_upload_budget_rows', ['report_start_date', 'report_end_date'])

    op.create_table(
        'ad_upload_placement_rows',
        sa.Column('id', sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column('source_file_id', sa.BigInteger(), sa.ForeignKey('ad_upload_files.id', ondelete='CASCADE'), nullable=False),
        sa.Column('source_row_no', sa.Integer(), nullable=False),
        sa.Column('report_start_date', sa.Date(), nullable=False),
        sa.Column('report_end_date', sa.Date(), nullable=False),
        sa.Column('campaign_name', sa.String(length=255), nullable=True),
        sa.Column('placement', sa.String(length=255), nullable=True),
        sa.Column('bidding_strategy', sa.String(length=128), nullable=True),
        sa.Column('impressions', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('clicks', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('spend', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('cpc', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('sales_7d', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('orders_7d', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('units_7d', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('acos', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('roas', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('raw_row', sa.JSON(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('now()')),
        sa.UniqueConstraint('source_file_id', 'source_row_no', name='ad_upload_placement_rows_source_row_key'),
    )
    op.create_index('idx_ad_upload_placement_rows_source_id', 'ad_upload_placement_rows', ['source_file_id'])
    op.create_index('idx_ad_upload_placement_rows_campaign', 'ad_upload_placement_rows', ['campaign_name'])
    op.create_index('idx_ad_upload_placement_rows_placement', 'ad_upload_placement_rows', ['placement'])
    op.create_index('idx_ad_upload_placement_rows_dates', 'ad_upload_placement_rows', ['report_start_date', 'report_end_date'])

    op.create_table(
        'ad_upload_invalid_traffic_rows',
        sa.Column('id', sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column('source_file_id', sa.BigInteger(), sa.ForeignKey('ad_upload_files.id', ondelete='CASCADE'), nullable=False),
        sa.Column('source_row_no', sa.Integer(), nullable=False),
        sa.Column('report_start_date', sa.Date(), nullable=False),
        sa.Column('report_end_date', sa.Date(), nullable=False),
        sa.Column('campaign_name', sa.String(length=255), nullable=True),
        sa.Column('status', sa.String(length=64), nullable=True),
        sa.Column('total_impressions', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('valid_impressions', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('invalid_impressions', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('invalid_impression_rate', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('total_clicks', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('valid_clicks', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('invalid_clicks', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('invalid_click_rate', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('raw_row', sa.JSON(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('now()')),
        sa.UniqueConstraint('source_file_id', 'source_row_no', name='ad_upload_invalid_traffic_rows_source_row_key'),
    )
    op.create_index('idx_ad_upload_invalid_traffic_rows_source_id', 'ad_upload_invalid_traffic_rows', ['source_file_id'])
    op.create_index('idx_ad_upload_invalid_traffic_rows_campaign', 'ad_upload_invalid_traffic_rows', ['campaign_name'])
    op.create_index('idx_ad_upload_invalid_traffic_rows_dates', 'ad_upload_invalid_traffic_rows', ['report_start_date', 'report_end_date'])


def downgrade() -> None:
    op.drop_index('idx_ad_upload_invalid_traffic_rows_dates', table_name='ad_upload_invalid_traffic_rows')
    op.drop_index('idx_ad_upload_invalid_traffic_rows_campaign', table_name='ad_upload_invalid_traffic_rows')
    op.drop_index('idx_ad_upload_invalid_traffic_rows_source_id', table_name='ad_upload_invalid_traffic_rows')
    op.drop_table('ad_upload_invalid_traffic_rows')

    op.drop_index('idx_ad_upload_placement_rows_dates', table_name='ad_upload_placement_rows')
    op.drop_index('idx_ad_upload_placement_rows_placement', table_name='ad_upload_placement_rows')
    op.drop_index('idx_ad_upload_placement_rows_campaign', table_name='ad_upload_placement_rows')
    op.drop_index('idx_ad_upload_placement_rows_source_id', table_name='ad_upload_placement_rows')
    op.drop_table('ad_upload_placement_rows')

    op.drop_index('idx_ad_upload_budget_rows_dates', table_name='ad_upload_budget_rows')
    op.drop_index('idx_ad_upload_budget_rows_campaign', table_name='ad_upload_budget_rows')
    op.drop_index('idx_ad_upload_budget_rows_source_id', table_name='ad_upload_budget_rows')
    op.drop_table('ad_upload_budget_rows')
