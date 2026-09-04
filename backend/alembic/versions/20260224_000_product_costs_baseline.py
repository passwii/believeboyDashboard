"""ensure product_costs baseline table exists

Revision ID: 20260224_000
Revises:
Create Date: 2026-02-24 00:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260224_000'
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table('product_costs'):
        return

    op.create_table(
        'product_costs',
        sa.Column(
            'id',
            sa.BigInteger().with_variant(sa.Integer, 'sqlite'),
            primary_key=True,
            autoincrement=True,
        ),
        sa.Column('project_name', sa.Text(), nullable=False),
        sa.Column('sku', sa.Text(), nullable=False),
        sa.Column('asin', sa.Text(), nullable=False),
        sa.Column('first_leg_unit_cost', sa.Numeric(12, 2), nullable=False, server_default='0'),
        sa.Column('fob_unit_cost', sa.Numeric(12, 2), nullable=False, server_default='0'),
        sa.Column('currency', sa.Text(), nullable=False, server_default='USD'),
        sa.Column('source_file', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint('first_leg_unit_cost >= 0', name='ck_product_costs_first_leg_unit_cost_non_negative'),
        sa.CheckConstraint('fob_unit_cost >= 0', name='ck_product_costs_fob_unit_cost_non_negative'),
        sa.UniqueConstraint('project_name', 'sku', 'asin', name='product_costs_project_sku_asin_key'),
    )
    op.create_index('idx_product_costs_project_name', 'product_costs', ['project_name'], unique=False)
    op.create_index('idx_product_costs_sku', 'product_costs', ['sku'], unique=False)
    op.create_index('idx_product_costs_asin', 'product_costs', ['asin'], unique=False)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table('product_costs'):
        return
    op.drop_index('idx_product_costs_asin', table_name='product_costs')
    op.drop_index('idx_product_costs_sku', table_name='product_costs')
    op.drop_index('idx_product_costs_project_name', table_name='product_costs')
    op.drop_table('product_costs')
