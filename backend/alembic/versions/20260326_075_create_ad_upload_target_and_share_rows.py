"""create ad upload target and share rows

Revision ID: 20260326_075
Revises: 20260326_074
Create Date: 2026-03-26 20:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260326_075'
down_revision: Union[str, None] = '20260326_074'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'ad_upload_target_rows',
        sa.Column('id', sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column('source_file_id', sa.BigInteger(), sa.ForeignKey('ad_upload_files.id', ondelete='CASCADE'), nullable=False),
        sa.Column('source_row_no', sa.Integer(), nullable=False),
        sa.Column('report_start_date', sa.Date(), nullable=False),
        sa.Column('report_end_date', sa.Date(), nullable=False),
        sa.Column('campaign_name', sa.String(length=255), nullable=True),
        sa.Column('ad_group_name', sa.String(length=255), nullable=True),
        sa.Column('target_text', sa.Text(), nullable=True),
        sa.Column('match_type', sa.String(length=64), nullable=True),
        sa.Column('impressions', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('top_of_search_impression_share', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('clicks', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('ctr', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('cpc', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('spend', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('sales_7d', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('orders_7d', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('units_7d', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('acos', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('roas', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('cvr_7d', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('raw_row', sa.JSON(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('now()')),
        sa.UniqueConstraint('source_file_id', 'source_row_no', name='ad_upload_target_rows_source_row_key'),
    )
    op.create_index('idx_ad_upload_target_rows_source_id', 'ad_upload_target_rows', ['source_file_id'])
    op.create_index('idx_ad_upload_target_rows_campaign', 'ad_upload_target_rows', ['campaign_name'])
    op.create_index('idx_ad_upload_target_rows_target', 'ad_upload_target_rows', ['target_text'])
    op.create_index('idx_ad_upload_target_rows_dates', 'ad_upload_target_rows', ['report_start_date', 'report_end_date'])

    op.create_table(
        'ad_upload_search_term_share_rows',
        sa.Column('id', sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column('source_file_id', sa.BigInteger(), sa.ForeignKey('ad_upload_files.id', ondelete='CASCADE'), nullable=False),
        sa.Column('source_row_no', sa.Integer(), nullable=False),
        sa.Column('report_start_date', sa.Date(), nullable=False),
        sa.Column('report_end_date', sa.Date(), nullable=False),
        sa.Column('search_term', sa.Text(), nullable=True),
        sa.Column('impression_rank', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('impression_share', sa.Numeric(18, 6), nullable=False, server_default='0'),
        sa.Column('target_text', sa.Text(), nullable=True),
        sa.Column('match_type', sa.String(length=64), nullable=True),
        sa.Column('campaign_name', sa.String(length=255), nullable=True),
        sa.Column('ad_group_name', sa.String(length=255), nullable=True),
        sa.Column('clicks', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('impressions', sa.Integer(), nullable=False, server_default='0'),
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
        sa.UniqueConstraint('source_file_id', 'source_row_no', name='ad_upload_search_term_share_rows_source_row_key'),
    )
    op.create_index('idx_ad_upload_search_term_share_rows_source_id', 'ad_upload_search_term_share_rows', ['source_file_id'])
    op.create_index('idx_ad_upload_search_term_share_rows_term', 'ad_upload_search_term_share_rows', ['search_term'])
    op.create_index('idx_ad_upload_search_term_share_rows_campaign', 'ad_upload_search_term_share_rows', ['campaign_name'])
    op.create_index('idx_ad_upload_search_term_share_rows_dates', 'ad_upload_search_term_share_rows', ['report_start_date', 'report_end_date'])


def downgrade() -> None:
    op.drop_index('idx_ad_upload_search_term_share_rows_dates', table_name='ad_upload_search_term_share_rows')
    op.drop_index('idx_ad_upload_search_term_share_rows_campaign', table_name='ad_upload_search_term_share_rows')
    op.drop_index('idx_ad_upload_search_term_share_rows_term', table_name='ad_upload_search_term_share_rows')
    op.drop_index('idx_ad_upload_search_term_share_rows_source_id', table_name='ad_upload_search_term_share_rows')
    op.drop_table('ad_upload_search_term_share_rows')

    op.drop_index('idx_ad_upload_target_rows_dates', table_name='ad_upload_target_rows')
    op.drop_index('idx_ad_upload_target_rows_target', table_name='ad_upload_target_rows')
    op.drop_index('idx_ad_upload_target_rows_campaign', table_name='ad_upload_target_rows')
    op.drop_index('idx_ad_upload_target_rows_source_id', table_name='ad_upload_target_rows')
    op.drop_table('ad_upload_target_rows')
