"""backfill missing sku info columns on product_costs

Revision ID: 20260313_044
Revises: 20260313_043
Create Date: 2026-03-13 21:45:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = '20260313_044'
down_revision = '20260313_043'
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {column['name'] for column in inspector.get_columns('product_costs')}

    if 'fnsku' not in columns:
        op.add_column('product_costs', sa.Column('fnsku', sa.String(), nullable=True))
        op.create_index('ix_product_costs_fnsku', 'product_costs', ['fnsku'], unique=False)
    elif 'ix_product_costs_fnsku' not in {index['name'] for index in inspector.get_indexes('product_costs')}:
        op.create_index('ix_product_costs_fnsku', 'product_costs', ['fnsku'], unique=False)

    numeric_columns = [
        ('package_length_cm', sa.Numeric(10, 2), '0'),
        ('package_width_cm', sa.Numeric(10, 2), '0'),
        ('package_height_cm', sa.Numeric(10, 2), '0'),
        ('weight_kg', sa.Numeric(10, 3), '0'),
        ('carton_length_cm', sa.Numeric(10, 2), '0'),
        ('carton_width_cm', sa.Numeric(10, 2), '0'),
        ('carton_height_cm', sa.Numeric(10, 2), '0'),
        ('carton_weight_kg', sa.Numeric(10, 3), '0'),
    ]
    for name, column_type, default_value in numeric_columns:
        if name not in columns:
            op.add_column('product_costs', sa.Column(name, column_type, nullable=False, server_default=default_value))

    if 'units_per_carton' not in columns:
        op.add_column('product_costs', sa.Column('units_per_carton', sa.Integer(), nullable=False, server_default='0'))


def downgrade() -> None:
    # This migration is a repair step for drifted environments; keep downgrade no-op.
    pass
