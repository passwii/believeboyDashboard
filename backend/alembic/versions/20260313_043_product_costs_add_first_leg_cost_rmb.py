"""add first_leg_cost_rmb to product_costs

Revision ID: 20260313_043
Revises: 20260313_042
Create Date: 2026-03-13 21:10:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = '20260313_043'
down_revision = '20260313_042'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('product_costs', sa.Column('first_leg_cost_rmb', sa.Numeric(12, 2), nullable=False, server_default='0'))


def downgrade() -> None:
    op.drop_column('product_costs', 'first_leg_cost_rmb')
