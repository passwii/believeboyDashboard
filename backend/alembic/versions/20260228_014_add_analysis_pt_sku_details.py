"""add product analysis pt sku details table

Revision ID: 20260228_014
Revises: 20260228_013
Create Date: 2026-02-28 23:45:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260228_014'
down_revision: Union[str, None] = '20260228_013'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

BIGINT_SQLITE = sa.BigInteger().with_variant(sa.Integer(), 'sqlite')


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table('analysis_pt_sku_details'):
        op.create_table(
            'analysis_pt_sku_details',
            sa.Column('id', BIGINT_SQLITE, primary_key=True, autoincrement=True),
            sa.Column('pt1_calculation_id', BIGINT_SQLITE, nullable=False),
            sa.Column('source_row_no', sa.Integer(), nullable=False),
            sa.Column('report_date', sa.String(length=32), nullable=True),
            sa.Column('sku', sa.String(length=128), nullable=True),
            sa.Column('asin', sa.String(length=64), nullable=True),
            sa.Column('total_units', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('total_sales_amount', sa.Numeric(18, 2), nullable=False, server_default=sa.text('0')),
            sa.Column('page_views', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('total_visitors', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('ad_impressions', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('ad_clicks', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('ad_orders', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('ad_spend', sa.Numeric(18, 2), nullable=False, server_default=sa.text('0')),
            sa.Column('ad_sales_amount', sa.Numeric(18, 2), nullable=False, server_default=sa.text('0')),
            sa.Column('actual_sales_amount', sa.Numeric(18, 2), nullable=False, server_default=sa.text('0')),
            sa.Column('actual_sales_units', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('actual_refund_amount', sa.Numeric(18, 2), nullable=False, server_default=sa.text('0')),
            sa.Column('actual_refund_units', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('profit_amount', sa.Numeric(18, 2), nullable=False, server_default=sa.text('0')),
            sa.Column('profit_rate', sa.Numeric(18, 6), nullable=False, server_default=sa.text('0')),
            sa.Column('raw_row', sa.JSON(), nullable=False),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('CURRENT_TIMESTAMP')),
            sa.ForeignKeyConstraint(['pt1_calculation_id'], ['analysis_pt1_calculation.id'], ondelete='CASCADE'),
            sa.UniqueConstraint('pt1_calculation_id', 'source_row_no', name='analysis_pt_sku_details_row_key'),
        )

    op.execute(
        'create index if not exists idx_analysis_pt_sku_details_pt1 '
        'on analysis_pt_sku_details (pt1_calculation_id)'
    )
    op.execute(
        'create index if not exists idx_analysis_pt_sku_details_sku '
        'on analysis_pt_sku_details (pt1_calculation_id, sku)'
    )
    op.execute(
        'create index if not exists idx_analysis_pt_sku_details_asin '
        'on analysis_pt_sku_details (pt1_calculation_id, asin)'
    )


def downgrade() -> None:
    op.execute('drop index if exists idx_analysis_pt_sku_details_asin')
    op.execute('drop index if exists idx_analysis_pt_sku_details_sku')
    op.execute('drop index if exists idx_analysis_pt_sku_details_pt1')
    op.execute('drop table if exists analysis_pt_sku_details')
