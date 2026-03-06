"""add country to product_costs and extend uniqueness

Revision ID: 20260306_025
Revises: 20260305_024
Create Date: 2026-03-06 10:30:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260306_025'
down_revision: Union[str, None] = '20260305_024'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(inspector: sa.Inspector, table_name: str) -> bool:
    return table_name in inspector.get_table_names()


def _has_column(inspector: sa.Inspector, table_name: str, column_name: str) -> bool:
    return any(col['name'] == column_name for col in inspector.get_columns(table_name))


def _has_index(inspector: sa.Inspector, table_name: str, index_name: str) -> bool:
    return any(idx.get('name') == index_name for idx in inspector.get_indexes(table_name))


def _has_unique_constraint(inspector: sa.Inspector, table_name: str, constraint_name: str) -> bool:
    return any(c.get('name') == constraint_name for c in inspector.get_unique_constraints(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if _has_table(inspector, 'product_costs') is False:
        return

    if _has_column(inspector, 'product_costs', 'country') is False:
        op.add_column(
            'product_costs',
            sa.Column('country', sa.String(length=2), nullable=False, server_default=sa.text("'US'")),
        )

    bind.execute(sa.text("update product_costs set country = 'US' where country is null or trim(country) = ''"))

    dialect = bind.dialect.name
    inspector = sa.inspect(bind)

    if _has_index(inspector, 'product_costs', 'idx_product_costs_country') is False:
        op.create_index('idx_product_costs_country', 'product_costs', ['country'], unique=False)

    if dialect != 'sqlite':
        op.execute(
            """
            alter table product_costs
            drop constraint if exists product_costs_project_sku_asin_key
            """
        )
        op.execute(
            """
            alter table product_costs
            drop constraint if exists product_costs_project_sku_asin_country_key
            """
        )
        op.execute(
            """
            alter table product_costs
            add constraint product_costs_project_sku_asin_country_key
            unique (project_name, sku, asin, country)
            """
        )
        op.execute(
            """
            alter table product_costs
            drop constraint if exists product_costs_country_check
            """
        )
        op.execute(
            """
            alter table product_costs
            add constraint product_costs_country_check
            check (country in ('US', 'DE', 'UK'))
            """
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if _has_table(inspector, 'product_costs') is False:
        return

    dialect = bind.dialect.name

    if dialect != 'sqlite':
        op.execute(
            """
            alter table product_costs
            drop constraint if exists product_costs_country_check
            """
        )
        op.execute(
            """
            alter table product_costs
            drop constraint if exists product_costs_project_sku_asin_country_key
            """
        )
        op.execute(
            """
            alter table product_costs
            add constraint product_costs_project_sku_asin_key
            unique (project_name, sku, asin)
            """
        )

    inspector = sa.inspect(bind)
    if _has_index(inspector, 'product_costs', 'idx_product_costs_country'):
        op.drop_index('idx_product_costs_country', table_name='product_costs')

    inspector = sa.inspect(bind)
    if _has_column(inspector, 'product_costs', 'country'):
        op.drop_column('product_costs', 'country')
