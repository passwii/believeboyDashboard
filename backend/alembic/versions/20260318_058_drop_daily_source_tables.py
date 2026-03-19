"""drop retired daily source tables

Revision ID: 20260318_058
Revises: 20260318_057
Create Date: 2026-03-18 22:20:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260318_058'
down_revision: Union[str, None] = '20260318_057'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

BIGINT_SQLITE = sa.BigInteger().with_variant(sa.Integer(), 'sqlite')


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if inspector.has_table('daily_ad_product'):
        op.execute('drop index if exists idx_daily_ad_product_scope')
        op.execute('drop index if exists idx_daily_ad_product_source_sku')
        op.execute('drop index if exists idx_daily_ad_product_source_id')
        op.execute('drop table if exists daily_ad_product')

    if inspector.has_table('daily_sales_order'):
        op.execute('drop index if exists idx_daily_sales_order_order_id')
        op.execute('drop index if exists idx_daily_sales_order_source_sku')
        op.execute('drop index if exists idx_daily_sales_order_source_status')
        op.execute('drop index if exists idx_daily_sales_order_source_purchase_date')
        op.execute('drop index if exists idx_daily_sales_order_source_id')
        op.execute('drop table if exists daily_sales_order')

    if inspector.has_table('daily_source_files'):
        op.execute('drop index if exists uq_daily_sources_current')
        op.execute('drop index if exists idx_daily_sources_project_type_country_date')
        op.execute('drop index if exists idx_daily_sources_country')
        op.execute('drop index if exists idx_daily_sources_ingestion_status')
        op.execute('drop index if exists idx_daily_sources_is_current')
        op.execute('drop index if exists idx_daily_sources_report_date')
        op.execute('drop index if exists idx_daily_sources_report_type')
        op.execute('drop index if exists idx_daily_sources_project_id')
        op.execute('drop table if exists daily_source_files')


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table('daily_source_files'):
        op.create_table(
            'daily_source_files',
            sa.Column('id', BIGINT_SQLITE, primary_key=True, autoincrement=True),
            sa.Column('project_id', BIGINT_SQLITE, nullable=False),
            sa.Column('report_type', sa.String(length=32), nullable=False),
            sa.Column('country', sa.String(length=2), nullable=False, server_default='US'),
            sa.Column('report_date', sa.Date(), nullable=False),
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
            sa.Column('ingestion_status', sa.String(length=16), nullable=False, server_default=sa.text('pending')),
            sa.Column('ingestion_error', sa.Text(), nullable=True),
            sa.Column('row_count_total', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('row_count_included', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('created_by', sa.String(length=255), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('CURRENT_TIMESTAMP')),
            sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('CURRENT_TIMESTAMP')),
            sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
            sa.UniqueConstraint('project_id', 'report_type', 'country', 'report_date', 'version', name='daily_sources_date_version_key'),
            sa.CheckConstraint("report_type in ('sales_report', 'ad_product_report')", name='ck_daily_sources_report_type'),
            sa.CheckConstraint('version >= 1', name='ck_daily_sources_version_positive'),
            sa.CheckConstraint("ingestion_status in ('pending', 'running', 'success', 'failed')", name='ck_daily_sources_ingestion_status'),
        )
        op.execute('create index if not exists idx_daily_sources_project_id on daily_source_files (project_id)')
        op.execute('create index if not exists idx_daily_sources_report_type on daily_source_files (report_type)')
        op.execute('create index if not exists idx_daily_sources_report_date on daily_source_files (report_date)')
        op.execute('create index if not exists idx_daily_sources_is_current on daily_source_files (is_current)')
        op.execute('create index if not exists idx_daily_sources_ingestion_status on daily_source_files (ingestion_status)')
        op.execute('create index if not exists idx_daily_sources_country on daily_source_files (country)')
        op.execute(
            'create index if not exists idx_daily_sources_project_type_country_date '
            'on daily_source_files (project_id, report_type, country, report_date)'
        )
        if bind.dialect.name == 'sqlite':
            op.execute(
                'create unique index if not exists uq_daily_sources_current '
                'on daily_source_files (project_id, report_type, country, report_date) '
                'where is_current = 1'
            )
        else:
            op.execute(
                'create unique index if not exists uq_daily_sources_current '
                'on daily_source_files (project_id, report_type, country, report_date) '
                'where is_current is true'
            )

    if not inspector.has_table('daily_sales_order'):
        op.create_table(
            'daily_sales_order',
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
            sa.ForeignKeyConstraint(['source_file_id'], ['daily_source_files.id'], ondelete='CASCADE'),
            sa.UniqueConstraint('source_file_id', 'source_row_no', name='daily_sales_order_source_row_key'),
        )
        op.execute('create index if not exists idx_daily_sales_order_source_id on daily_sales_order (source_file_id)')
        op.execute('create index if not exists idx_daily_sales_order_source_purchase_date on daily_sales_order (source_file_id, purchase_date_pt)')
        op.execute('create index if not exists idx_daily_sales_order_source_status on daily_sales_order (source_file_id, order_status)')
        op.execute('create index if not exists idx_daily_sales_order_source_sku on daily_sales_order (source_file_id, sku)')
        op.execute('create index if not exists idx_daily_sales_order_order_id on daily_sales_order (amazon_order_id)')

    if not inspector.has_table('daily_ad_product'):
        op.create_table(
            'daily_ad_product',
            sa.Column('id', BIGINT_SQLITE, primary_key=True, autoincrement=True),
            sa.Column('source_file_id', BIGINT_SQLITE, nullable=False),
            sa.Column('source_row_no', sa.Integer(), nullable=False),
            sa.Column('sku', sa.String(length=128), nullable=True),
            sa.Column('asin', sa.String(length=64), nullable=True),
            sa.Column('impressions', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('clicks', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('spend', sa.Numeric(18, 2), nullable=False, server_default=sa.text('0')),
            sa.Column('sales_7d', sa.Numeric(18, 2), nullable=False, server_default=sa.text('0')),
            sa.Column('orders_7d', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('scope_status', sa.String(length=32), nullable=False, server_default=sa.text("'excluded_unmapped'")),
            sa.Column('scope_reason', sa.String(length=255), nullable=True),
            sa.Column('raw_row', sa.JSON(), nullable=False),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('CURRENT_TIMESTAMP')),
            sa.ForeignKeyConstraint(['source_file_id'], ['daily_source_files.id'], ondelete='CASCADE'),
            sa.UniqueConstraint('source_file_id', 'source_row_no', name='daily_ad_product_source_row_key'),
            sa.CheckConstraint(
                "scope_status in ('included_product', 'excluded_store_level', 'excluded_unmapped')",
                name='ck_daily_ad_product_scope_status',
            ),
        )
        op.execute('create index if not exists idx_daily_ad_product_source_id on daily_ad_product (source_file_id)')
        op.execute('create index if not exists idx_daily_ad_product_source_sku on daily_ad_product (source_file_id, sku)')
        op.execute('create index if not exists idx_daily_ad_product_scope on daily_ad_product (source_file_id, scope_status)')
