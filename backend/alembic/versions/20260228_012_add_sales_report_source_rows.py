"""add sales report source rows and constraints

Revision ID: 20260228_012
Revises: 20260228_011
Create Date: 2026-02-28 19:05:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260228_012'
down_revision: Union[str, None] = '20260228_011'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

BIGINT_SQLITE = sa.BigInteger().with_variant(sa.Integer(), 'sqlite')


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    dialect = bind.dialect.name

    if inspector.has_table('analysis_source_files'):
        if dialect != 'sqlite':
            op.execute('alter table analysis_source_files drop constraint if exists ck_analysis_sources_report_type')
            op.execute(
                "alter table analysis_source_files add constraint ck_analysis_sources_report_type "
                "check (report_type in ('business_report', 'payment_report', 'ad_report', 'sales_report', 'inventory_report'))"
            )
            op.execute('alter table analysis_source_files drop constraint if exists ck_analysis_sources_period_or_snapshot')
            op.execute(
                "alter table analysis_source_files add constraint ck_analysis_sources_period_or_snapshot "
                "check (("
                "report_type in ('business_report', 'payment_report', 'ad_report', 'sales_report') "
                "and period_start_date is not null "
                "and period_end_date is not null "
                "and period_start_date <= period_end_date "
                "and snapshot_at is null"
                ") or ("
                "report_type = 'inventory_report' "
                "and snapshot_at is not null"
                "))"
            )

        op.execute('drop index if exists uq_analysis_sources_period_current')
        if dialect == 'sqlite':
            op.execute(
                'create unique index if not exists uq_analysis_sources_period_current '
                'on analysis_source_files (project_id, report_type, period_start_date, period_end_date) '
                "where report_type in ('business_report', 'payment_report', 'ad_report', 'sales_report') and is_current = 1"
            )
        else:
            op.execute(
                'create unique index if not exists uq_analysis_sources_period_current '
                'on analysis_source_files (project_id, report_type, period_start_date, period_end_date) '
                "where report_type in ('business_report', 'payment_report', 'ad_report', 'sales_report') and is_current is true"
            )

    if not inspector.has_table('analysis_sales_order_rows'):
        op.create_table(
            'analysis_sales_order_rows',
            sa.Column('id', BIGINT_SQLITE, primary_key=True, autoincrement=True),
            sa.Column('source_file_id', BIGINT_SQLITE, nullable=False),
            sa.Column('source_row_no', sa.Integer(), nullable=False),
            sa.Column('amazon_order_id', sa.String(length=64), nullable=False),
            sa.Column('purchase_at_utc', sa.DateTime(timezone=True), nullable=False),
            sa.Column('purchase_at_pt', sa.DateTime(timezone=False), nullable=False),
            sa.Column('purchase_date_pt', sa.Date(), nullable=False),
            sa.Column('order_status', sa.String(length=32), nullable=False),
            sa.Column('sku', sa.String(length=128), nullable=True),
            sa.Column('asin', sa.String(length=64), nullable=True),
            sa.Column('quantity', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('item_price', sa.Numeric(18, 2), nullable=False, server_default=sa.text('0')),
            sa.Column('currency', sa.String(length=8), nullable=True),
            sa.Column('is_counted_sales', sa.Boolean(), nullable=False, server_default=sa.text('false')),
            sa.Column('status_rule_version', sa.Integer(), nullable=False, server_default=sa.text('1')),
            sa.Column('raw_row', sa.JSON(), nullable=False),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('CURRENT_TIMESTAMP')),
            sa.ForeignKeyConstraint(['source_file_id'], ['analysis_source_files.id'], ondelete='CASCADE'),
            sa.UniqueConstraint('source_file_id', 'source_row_no', name='analysis_sales_order_rows_source_row_key'),
        )

    op.execute(
        'create index if not exists idx_analysis_sales_order_source_id '
        'on analysis_sales_order_rows (source_file_id)'
    )
    op.execute(
        'create index if not exists idx_analysis_sales_order_source_purchase_date '
        'on analysis_sales_order_rows (source_file_id, purchase_date_pt)'
    )
    op.execute(
        'create index if not exists idx_analysis_sales_order_source_status '
        'on analysis_sales_order_rows (source_file_id, order_status)'
    )
    op.execute(
        'create index if not exists idx_analysis_sales_order_source_sku '
        'on analysis_sales_order_rows (source_file_id, sku)'
    )
    op.execute(
        'create index if not exists idx_analysis_sales_order_order_id '
        'on analysis_sales_order_rows (amazon_order_id)'
    )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    dialect = bind.dialect.name

    op.execute('drop index if exists idx_analysis_sales_order_order_id')
    op.execute('drop index if exists idx_analysis_sales_order_source_sku')
    op.execute('drop index if exists idx_analysis_sales_order_source_status')
    op.execute('drop index if exists idx_analysis_sales_order_source_purchase_date')
    op.execute('drop index if exists idx_analysis_sales_order_source_id')
    op.execute('drop table if exists analysis_sales_order_rows')

    op.execute('drop index if exists uq_analysis_sources_period_current')
    if inspector.has_table('analysis_source_files'):
        if dialect == 'sqlite':
            op.execute(
                'create unique index if not exists uq_analysis_sources_period_current '
                'on analysis_source_files (project_id, report_type, period_start_date, period_end_date) '
                "where report_type in ('business_report', 'payment_report', 'ad_report') and is_current = 1"
            )
        else:
            op.execute(
                'create unique index if not exists uq_analysis_sources_period_current '
                'on analysis_source_files (project_id, report_type, period_start_date, period_end_date) '
                "where report_type in ('business_report', 'payment_report', 'ad_report') and is_current is true"
            )
            op.execute('alter table analysis_source_files drop constraint if exists ck_analysis_sources_period_or_snapshot')
            op.execute(
                "alter table analysis_source_files add constraint ck_analysis_sources_period_or_snapshot "
                "check (("
                "report_type in ('business_report', 'payment_report', 'ad_report') "
                "and period_start_date is not null "
                "and period_end_date is not null "
                "and period_start_date <= period_end_date "
                "and snapshot_at is null"
                ") or ("
                "report_type = 'inventory_report' "
                "and snapshot_at is not null"
                "))"
            )
            op.execute('alter table analysis_source_files drop constraint if exists ck_analysis_sources_report_type')
            op.execute(
                "alter table analysis_source_files add constraint ck_analysis_sources_report_type "
                "check (report_type in ('business_report', 'payment_report', 'ad_report', 'inventory_report'))"
            )
