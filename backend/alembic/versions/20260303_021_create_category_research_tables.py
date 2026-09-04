"""create category research tables

Revision ID: 20260303_021
Revises: 20260302_020
Create Date: 2026-03-03 13:30:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260303_021'
down_revision: Union[str, None] = '20260302_020'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


BIGINT_SQLITE = sa.BigInteger().with_variant(sa.Integer(), 'sqlite')


def _has_table(inspector: sa.Inspector, table_name: str) -> bool:
    return table_name in inspector.get_table_names()


def _has_index(inspector: sa.Inspector, table_name: str, index_name: str) -> bool:
    return any(idx.get('name') == index_name for idx in inspector.get_indexes(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if _has_table(inspector, 'category_research_datasets') is False:
        op.create_table(
            'category_research_datasets',
            sa.Column('id', BIGINT_SQLITE, primary_key=True, autoincrement=True),
            sa.Column('marketplace', sa.String(length=16), nullable=False, server_default=sa.text("'US'")),
            sa.Column('category_keyword_en', sa.String(length=255), nullable=False),
            sa.Column('category_name_zh', sa.String(length=255), nullable=False),
            sa.Column('version', sa.Integer(), nullable=False, server_default=sa.text('1')),
            sa.Column('is_current', sa.Boolean(), nullable=False, server_default=sa.text('false')),
            sa.Column('superseded_at', sa.DateTime(timezone=True), nullable=True),
            sa.Column('upload_file_id', sa.String(length=255), nullable=False),
            sa.Column('upload_file_path', sa.String(length=1024), nullable=False),
            sa.Column('original_filename', sa.String(length=255), nullable=True),
            sa.Column('stored_filename', sa.String(length=255), nullable=False),
            sa.Column('file_size_bytes', sa.BigInteger(), nullable=True),
            sa.Column('file_sha256', sa.String(length=64), nullable=True),
            sa.Column('ingestion_status', sa.String(length=16), nullable=False, server_default=sa.text("'pending'")),
            sa.Column('ingestion_error', sa.Text(), nullable=True),
            sa.Column('row_count_products', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('row_count_trends', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('quality_warnings', sa.JSON(), nullable=False),
            sa.Column('created_by', sa.String(length=255), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('CURRENT_TIMESTAMP')),
            sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('CURRENT_TIMESTAMP')),
            sa.UniqueConstraint(
                'marketplace',
                'category_keyword_en',
                'version',
                name='uq_category_research_marketplace_keyword_version',
            ),
            sa.CheckConstraint('version >= 1', name='ck_category_research_version_positive'),
            sa.CheckConstraint(
                "ingestion_status in ('pending', 'running', 'success', 'failed')",
                name='ck_category_research_ingestion_status',
            ),
        )

    inspector = sa.inspect(bind)
    if _has_index(inspector, 'category_research_datasets', 'idx_category_research_marketplace_keyword_current') is False:
        op.create_index(
            'idx_category_research_marketplace_keyword_current',
            'category_research_datasets',
            ['marketplace', 'category_keyword_en', 'is_current'],
            unique=False,
        )
    if _has_index(inspector, 'category_research_datasets', 'idx_category_research_created_at') is False:
        op.create_index('idx_category_research_created_at', 'category_research_datasets', ['created_at'], unique=False)

    inspector = sa.inspect(bind)
    if _has_table(inspector, 'category_research_product_details') is False:
        op.create_table(
            'category_research_product_details',
            sa.Column('id', BIGINT_SQLITE, primary_key=True, autoincrement=True),
            sa.Column('dataset_id', BIGINT_SQLITE, nullable=False),
            sa.Column('source_row_no', sa.Integer(), nullable=False),
            sa.Column('asin', sa.String(length=64), nullable=True),
            sa.Column('parent_asin', sa.String(length=64), nullable=True),
            sa.Column('product_name', sa.String(length=2048), nullable=True),
            sa.Column('brand', sa.String(length=255), nullable=True),
            sa.Column('seller', sa.String(length=255), nullable=True),
            sa.Column('price_usd', sa.Numeric(18, 2), nullable=True),
            sa.Column('monthly_sales', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('monthly_revenue_usd', sa.Numeric(18, 2), nullable=True),
            sa.Column('rating', sa.Numeric(10, 2), nullable=True),
            sa.Column('review_count', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('launch_date', sa.Date(), nullable=True),
            sa.Column('listing_age_days', sa.Integer(), nullable=True),
            sa.Column('fba_fee_usd', sa.Numeric(18, 2), nullable=True),
            sa.Column('fulfillment_method', sa.String(length=64), nullable=True),
            sa.Column('is_amazon', sa.Boolean(), nullable=False, server_default=sa.text('false')),
            sa.Column('is_new_90d', sa.Boolean(), nullable=False, server_default=sa.text('false')),
            sa.Column('raw_row', sa.JSON(), nullable=False),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('CURRENT_TIMESTAMP')),
            sa.ForeignKeyConstraint(['dataset_id'], ['category_research_datasets.id'], ondelete='CASCADE'),
            sa.UniqueConstraint('dataset_id', 'source_row_no', name='uq_category_research_product_source_row'),
        )

    inspector = sa.inspect(bind)
    if _has_index(inspector, 'category_research_product_details', 'idx_category_research_product_dataset_asin') is False:
        op.create_index(
            'idx_category_research_product_dataset_asin',
            'category_research_product_details',
            ['dataset_id', 'asin'],
            unique=False,
        )
    if _has_index(inspector, 'category_research_product_details', 'idx_category_research_product_dataset_brand') is False:
        op.create_index(
            'idx_category_research_product_dataset_brand',
            'category_research_product_details',
            ['dataset_id', 'brand'],
            unique=False,
        )
    if _has_index(inspector, 'category_research_product_details', 'idx_category_research_product_dataset_price') is False:
        op.create_index(
            'idx_category_research_product_dataset_price',
            'category_research_product_details',
            ['dataset_id', 'price_usd'],
            unique=False,
        )

    inspector = sa.inspect(bind)
    if _has_table(inspector, 'category_research_sales_trends') is False:
        op.create_table(
            'category_research_sales_trends',
            sa.Column('id', BIGINT_SQLITE, primary_key=True, autoincrement=True),
            sa.Column('dataset_id', BIGINT_SQLITE, nullable=False),
            sa.Column('asin', sa.String(length=64), nullable=False),
            sa.Column('parent_asin', sa.String(length=64), nullable=True),
            sa.Column('year_month', sa.String(length=7), nullable=False),
            sa.Column('monthly_sales', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('CURRENT_TIMESTAMP')),
            sa.ForeignKeyConstraint(['dataset_id'], ['category_research_datasets.id'], ondelete='CASCADE'),
            sa.UniqueConstraint(
                'dataset_id',
                'asin',
                'year_month',
                name='uq_category_research_trend_dataset_asin_month',
            ),
        )

    inspector = sa.inspect(bind)
    if _has_index(inspector, 'category_research_sales_trends', 'idx_category_research_trend_dataset_asin') is False:
        op.create_index(
            'idx_category_research_trend_dataset_asin',
            'category_research_sales_trends',
            ['dataset_id', 'asin'],
            unique=False,
        )
    if _has_index(inspector, 'category_research_sales_trends', 'idx_category_research_trend_dataset_month') is False:
        op.create_index(
            'idx_category_research_trend_dataset_month',
            'category_research_sales_trends',
            ['dataset_id', 'year_month'],
            unique=False,
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if _has_table(inspector, 'category_research_sales_trends'):
        if _has_index(inspector, 'category_research_sales_trends', 'idx_category_research_trend_dataset_month'):
            op.drop_index('idx_category_research_trend_dataset_month', table_name='category_research_sales_trends')
        if _has_index(inspector, 'category_research_sales_trends', 'idx_category_research_trend_dataset_asin'):
            op.drop_index('idx_category_research_trend_dataset_asin', table_name='category_research_sales_trends')
        op.drop_table('category_research_sales_trends')

    inspector = sa.inspect(bind)
    if _has_table(inspector, 'category_research_product_details'):
        if _has_index(inspector, 'category_research_product_details', 'idx_category_research_product_dataset_price'):
            op.drop_index('idx_category_research_product_dataset_price', table_name='category_research_product_details')
        if _has_index(inspector, 'category_research_product_details', 'idx_category_research_product_dataset_brand'):
            op.drop_index('idx_category_research_product_dataset_brand', table_name='category_research_product_details')
        if _has_index(inspector, 'category_research_product_details', 'idx_category_research_product_dataset_asin'):
            op.drop_index('idx_category_research_product_dataset_asin', table_name='category_research_product_details')
        op.drop_table('category_research_product_details')

    inspector = sa.inspect(bind)
    if _has_table(inspector, 'category_research_datasets'):
        if _has_index(inspector, 'category_research_datasets', 'idx_category_research_created_at'):
            op.drop_index('idx_category_research_created_at', table_name='category_research_datasets')
        if _has_index(inspector, 'category_research_datasets', 'idx_category_research_marketplace_keyword_current'):
            op.drop_index('idx_category_research_marketplace_keyword_current', table_name='category_research_datasets')
        op.drop_table('category_research_datasets')
