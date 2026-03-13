"""add sku info fields to product_costs

Revision ID: 20260313_041
Revises: 20260313_040
Create Date: 2026-03-13 18:30:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = '20260313_041'
down_revision = '20260313_040'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('product_costs', sa.Column('fnsku', sa.String(), nullable=True))
    op.add_column('product_costs', sa.Column('package_length_cm', sa.Numeric(10, 2), nullable=False, server_default='0'))
    op.add_column('product_costs', sa.Column('package_width_cm', sa.Numeric(10, 2), nullable=False, server_default='0'))
    op.add_column('product_costs', sa.Column('package_height_cm', sa.Numeric(10, 2), nullable=False, server_default='0'))
    op.add_column('product_costs', sa.Column('weight_kg', sa.Numeric(10, 3), nullable=False, server_default='0'))
    op.add_column('product_costs', sa.Column('carton_length_cm', sa.Numeric(10, 2), nullable=False, server_default='0'))
    op.add_column('product_costs', sa.Column('carton_width_cm', sa.Numeric(10, 2), nullable=False, server_default='0'))
    op.add_column('product_costs', sa.Column('carton_height_cm', sa.Numeric(10, 2), nullable=False, server_default='0'))
    op.add_column('product_costs', sa.Column('carton_weight_kg', sa.Numeric(10, 3), nullable=False, server_default='0'))
    op.add_column('product_costs', sa.Column('units_per_carton', sa.Integer(), nullable=False, server_default='0'))
    op.create_index('ix_product_costs_fnsku', 'product_costs', ['fnsku'], unique=False)


def downgrade() -> None:
    op.drop_index('ix_product_costs_fnsku', table_name='product_costs')
    op.drop_column('product_costs', 'units_per_carton')
    op.drop_column('product_costs', 'carton_weight_kg')
    op.drop_column('product_costs', 'carton_height_cm')
    op.drop_column('product_costs', 'carton_width_cm')
    op.drop_column('product_costs', 'carton_length_cm')
    op.drop_column('product_costs', 'weight_kg')
    op.drop_column('product_costs', 'package_height_cm')
    op.drop_column('product_costs', 'package_width_cm')
    op.drop_column('product_costs', 'package_length_cm')
    op.drop_column('product_costs', 'fnsku')
