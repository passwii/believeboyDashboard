"""add product analysis source persistence tables

Revision ID: 20260227_010
Revises: 20260227_009
Create Date: 2026-02-27 12:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260227_010'
down_revision: Union[str, None] = '20260227_009'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


BIGINT_SQLITE = sa.BigInteger().with_variant(sa.Integer(), 'sqlite')


def _money_column(name: str) -> sa.Column:
    return sa.Column(name, sa.Numeric(18, 2), nullable=False, server_default=sa.text('0'))


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    dialect = bind.dialect.name

    if not inspector.has_table('analysis_source_files'):
        op.create_table(
            'analysis_source_files',
            sa.Column('id', BIGINT_SQLITE, primary_key=True, autoincrement=True),
            sa.Column('project_id', BIGINT_SQLITE, nullable=False),
            sa.Column('report_type', sa.String(length=32), nullable=False),
            sa.Column('period_start_date', sa.Date(), nullable=True),
            sa.Column('period_end_date', sa.Date(), nullable=True),
            sa.Column('snapshot_at', sa.DateTime(timezone=True), nullable=True),
            sa.Column('version', sa.Integer(), nullable=False, server_default=sa.text('1')),
            sa.Column('is_current', sa.Boolean(), nullable=False, server_default=sa.text('false')),
            sa.Column('superseded_at', sa.DateTime(timezone=True), nullable=True),
            sa.Column('upload_file_id', sa.String(length=255), nullable=False),
            sa.Column('upload_file_path', sa.String(length=1024), nullable=False),
            sa.Column('original_filename', sa.String(length=255), nullable=True),
            sa.Column('stored_filename', sa.String(length=255), nullable=False),
            sa.Column('logical_filename', sa.String(length=255), nullable=False),
            sa.Column('storage_key', sa.String(length=1024), nullable=False),
            sa.Column('file_size_bytes', sa.BigInteger(), nullable=True),
            sa.Column('file_sha256', sa.String(length=64), nullable=True),
            sa.Column('ingestion_status', sa.String(length=16), nullable=False, server_default=sa.text("'pending'")),
            sa.Column('ingestion_error', sa.Text(), nullable=True),
            sa.Column('row_count_total', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('row_count_included', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('created_by', sa.String(length=255), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('CURRENT_TIMESTAMP')),
            sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('CURRENT_TIMESTAMP')),
            sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
            sa.UniqueConstraint(
                'project_id',
                'report_type',
                'period_start_date',
                'period_end_date',
                'version',
                name='analysis_sources_period_version_key',
            ),
            sa.CheckConstraint(
                "report_type in ('business_report', 'payment_report', 'ad_report', 'inventory_report')",
                name='ck_analysis_sources_report_type',
            ),
            sa.CheckConstraint('version >= 1', name='ck_analysis_sources_version_positive'),
            sa.CheckConstraint(
                "ingestion_status in ('pending', 'running', 'success', 'failed')",
                name='ck_analysis_sources_ingestion_status',
            ),
            sa.CheckConstraint(
                "("
                "report_type in ('business_report', 'payment_report', 'ad_report') "
                'and period_start_date is not null '
                'and period_end_date is not null '
                'and period_start_date <= period_end_date '
                'and snapshot_at is null'
                ")"
                " or "
                "("
                "report_type = 'inventory_report' "
                'and snapshot_at is not null'
                ")",
                name='ck_analysis_sources_period_or_snapshot',
            ),
        )

    op.execute('create index if not exists idx_analysis_sources_project_id on analysis_source_files (project_id)')
    op.execute('create index if not exists idx_analysis_sources_report_type on analysis_source_files (report_type)')
    op.execute('create index if not exists idx_analysis_sources_is_current on analysis_source_files (is_current)')
    op.execute(
        'create index if not exists idx_analysis_sources_ingestion_status on analysis_source_files (ingestion_status)'
    )
    op.execute(
        'create index if not exists idx_analysis_sources_project_type_period '
        'on analysis_source_files (project_id, report_type, period_start_date, period_end_date)'
    )

    if dialect == 'sqlite':
        op.execute(
            'create unique index if not exists uq_analysis_sources_period_current '
            'on analysis_source_files (project_id, report_type, period_start_date, period_end_date) '
            "where report_type in ('business_report', 'payment_report', 'ad_report') and is_current = 1"
        )
        op.execute(
            'create unique index if not exists uq_analysis_sources_inventory_current '
            'on analysis_source_files (project_id, report_type) '
            "where report_type = 'inventory_report' and is_current = 1"
        )
    else:
        op.execute(
            'create unique index if not exists uq_analysis_sources_period_current '
            'on analysis_source_files (project_id, report_type, period_start_date, period_end_date) '
            "where report_type in ('business_report', 'payment_report', 'ad_report') and is_current is true"
        )
        op.execute(
            'create unique index if not exists uq_analysis_sources_inventory_current '
            'on analysis_source_files (project_id, report_type) '
            "where report_type = 'inventory_report' and is_current is true"
        )

    if not inspector.has_table('analysis_business_rows'):
        op.create_table(
            'analysis_business_rows',
            sa.Column('id', BIGINT_SQLITE, primary_key=True, autoincrement=True),
            sa.Column('source_file_id', BIGINT_SQLITE, nullable=False),
            sa.Column('source_row_no', sa.Integer(), nullable=False),
            sa.Column('asin', sa.String(length=64), nullable=True),
            sa.Column('page_views', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('units_ordered', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('sessions', sa.Integer(), nullable=False, server_default=sa.text('0')),
            _money_column('ordered_sales_amount'),
            sa.Column('raw_row', sa.JSON(), nullable=False),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('CURRENT_TIMESTAMP')),
            sa.ForeignKeyConstraint(['source_file_id'], ['analysis_source_files.id'], ondelete='CASCADE'),
            sa.UniqueConstraint('source_file_id', 'source_row_no', name='analysis_business_rows_source_row_key'),
        )
    op.execute('create index if not exists idx_analysis_business_source_id on analysis_business_rows (source_file_id)')
    op.execute(
        'create index if not exists idx_analysis_business_source_asin on analysis_business_rows (source_file_id, asin)'
    )

    if not inspector.has_table('analysis_payment_rows'):
        op.create_table(
            'analysis_payment_rows',
            sa.Column('id', BIGINT_SQLITE, primary_key=True, autoincrement=True),
            sa.Column('source_file_id', BIGINT_SQLITE, nullable=False),
            sa.Column('source_row_no', sa.Integer(), nullable=False),
            sa.Column('transaction_at', sa.DateTime(timezone=True), nullable=True),
            sa.Column('transaction_type', sa.String(length=64), nullable=False),
            sa.Column('order_id', sa.String(length=64), nullable=True),
            sa.Column('sku', sa.String(length=128), nullable=True),
            sa.Column('asin', sa.String(length=64), nullable=True),
            sa.Column('quantity', sa.Integer(), nullable=False, server_default=sa.text('0')),
            _money_column('product_sales'),
            _money_column('shipping_credits'),
            _money_column('promotional_rebates'),
            _money_column('other_amount'),
            _money_column('selling_fees'),
            _money_column('fba_fees'),
            _money_column('total_amount'),
            sa.Column('scope_status', sa.String(length=32), nullable=False, server_default=sa.text("'excluded_unmapped'")),
            sa.Column('scope_reason', sa.String(length=255), nullable=True),
            sa.Column('raw_row', sa.JSON(), nullable=False),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('CURRENT_TIMESTAMP')),
            sa.ForeignKeyConstraint(['source_file_id'], ['analysis_source_files.id'], ondelete='CASCADE'),
            sa.UniqueConstraint('source_file_id', 'source_row_no', name='analysis_payment_rows_source_row_key'),
            sa.CheckConstraint(
                "scope_status in ('included_product', 'excluded_store_level', 'excluded_unmapped')",
                name='ck_analysis_payment_scope_status',
            ),
        )
    op.execute('create index if not exists idx_analysis_payment_source_id on analysis_payment_rows (source_file_id)')
    op.execute(
        'create index if not exists idx_analysis_payment_source_sku on analysis_payment_rows (source_file_id, sku)'
    )
    op.execute(
        'create index if not exists idx_analysis_payment_source_asin on analysis_payment_rows (source_file_id, asin)'
    )
    op.execute(
        'create index if not exists idx_analysis_payment_scope on analysis_payment_rows (source_file_id, scope_status)'
    )
    op.execute(
        'create index if not exists idx_analysis_payment_type on analysis_payment_rows (source_file_id, transaction_type)'
    )

    if not inspector.has_table('analysis_ad_rows'):
        op.create_table(
            'analysis_ad_rows',
            sa.Column('id', BIGINT_SQLITE, primary_key=True, autoincrement=True),
            sa.Column('source_file_id', BIGINT_SQLITE, nullable=False),
            sa.Column('source_row_no', sa.Integer(), nullable=False),
            sa.Column('sku', sa.String(length=128), nullable=True),
            sa.Column('asin', sa.String(length=64), nullable=True),
            sa.Column('impressions', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('clicks', sa.Integer(), nullable=False, server_default=sa.text('0')),
            _money_column('spend'),
            _money_column('sales_7d'),
            sa.Column('orders_7d', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('scope_status', sa.String(length=32), nullable=False, server_default=sa.text("'excluded_unmapped'")),
            sa.Column('scope_reason', sa.String(length=255), nullable=True),
            sa.Column('raw_row', sa.JSON(), nullable=False),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('CURRENT_TIMESTAMP')),
            sa.ForeignKeyConstraint(['source_file_id'], ['analysis_source_files.id'], ondelete='CASCADE'),
            sa.UniqueConstraint('source_file_id', 'source_row_no', name='analysis_ad_rows_source_row_key'),
            sa.CheckConstraint(
                "scope_status in ('included_product', 'excluded_store_level', 'excluded_unmapped')",
                name='ck_analysis_ad_scope_status',
            ),
        )
    op.execute('create index if not exists idx_analysis_ad_source_id on analysis_ad_rows (source_file_id)')
    op.execute('create index if not exists idx_analysis_ad_source_sku on analysis_ad_rows (source_file_id, sku)')
    op.execute('create index if not exists idx_analysis_ad_scope on analysis_ad_rows (source_file_id, scope_status)')

    if not inspector.has_table('inventory_snapshot_rows'):
        op.create_table(
            'inventory_snapshot_rows',
            sa.Column('id', BIGINT_SQLITE, primary_key=True, autoincrement=True),
            sa.Column('source_file_id', BIGINT_SQLITE, nullable=False),
            sa.Column('source_row_no', sa.Integer(), nullable=False),
            sa.Column('sku', sa.String(length=128), nullable=True),
            sa.Column('asin', sa.String(length=64), nullable=True),
            sa.Column('available_qty', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('age_0_90_qty', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('age_91_180_qty', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('age_181_270_qty', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('age_271_365_qty', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('age_365_plus_qty', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('recommended_action', sa.String(length=255), nullable=True),
            sa.Column('stock_status', sa.String(length=16), nullable=False),
            sa.Column('aging_status', sa.String(length=16), nullable=False),
            sa.Column('raw_row', sa.JSON(), nullable=False),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('CURRENT_TIMESTAMP')),
            sa.ForeignKeyConstraint(['source_file_id'], ['analysis_source_files.id'], ondelete='CASCADE'),
            sa.UniqueConstraint('source_file_id', 'source_row_no', name='inventory_snapshot_rows_source_row_key'),
            sa.CheckConstraint("stock_status in ('in_stock', 'out_of_stock')", name='ck_inventory_snapshot_stock_status'),
            sa.CheckConstraint("aging_status in ('fresh', 'aging', 'over_aged')", name='ck_inventory_snapshot_aging_status'),
        )
    op.execute('create index if not exists idx_inventory_snapshot_source_id on inventory_snapshot_rows (source_file_id)')
    op.execute(
        'create index if not exists idx_inventory_snapshot_source_sku on inventory_snapshot_rows (source_file_id, sku)'
    )
    op.execute(
        'create index if not exists idx_inventory_snapshot_stock on inventory_snapshot_rows (source_file_id, stock_status)'
    )
    op.execute(
        'create index if not exists idx_inventory_snapshot_aging on inventory_snapshot_rows (source_file_id, aging_status)'
    )


def downgrade() -> None:
    op.execute('drop index if exists idx_inventory_snapshot_aging')
    op.execute('drop index if exists idx_inventory_snapshot_stock')
    op.execute('drop index if exists idx_inventory_snapshot_source_sku')
    op.execute('drop index if exists idx_inventory_snapshot_source_id')
    op.execute('drop table if exists inventory_snapshot_rows')

    op.execute('drop index if exists idx_analysis_ad_scope')
    op.execute('drop index if exists idx_analysis_ad_source_sku')
    op.execute('drop index if exists idx_analysis_ad_source_id')
    op.execute('drop table if exists analysis_ad_rows')

    op.execute('drop index if exists idx_analysis_payment_type')
    op.execute('drop index if exists idx_analysis_payment_scope')
    op.execute('drop index if exists idx_analysis_payment_source_asin')
    op.execute('drop index if exists idx_analysis_payment_source_sku')
    op.execute('drop index if exists idx_analysis_payment_source_id')
    op.execute('drop table if exists analysis_payment_rows')

    op.execute('drop index if exists idx_analysis_business_source_asin')
    op.execute('drop index if exists idx_analysis_business_source_id')
    op.execute('drop table if exists analysis_business_rows')

    op.execute('drop index if exists uq_analysis_sources_inventory_current')
    op.execute('drop index if exists uq_analysis_sources_period_current')
    op.execute('drop index if exists idx_analysis_sources_project_type_period')
    op.execute('drop index if exists idx_analysis_sources_ingestion_status')
    op.execute('drop index if exists idx_analysis_sources_is_current')
    op.execute('drop index if exists idx_analysis_sources_report_type')
    op.execute('drop index if exists idx_analysis_sources_project_id')
    op.execute('drop table if exists analysis_source_files')
