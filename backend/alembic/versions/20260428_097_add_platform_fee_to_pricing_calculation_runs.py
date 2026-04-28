"""add_platform_fee_to_pricing_calculation_runs

Revision ID: 20260428_097
Revises: 1285db6d3ce4
Create Date: 2026-04-28

"""
from alembic import op
import sqlalchemy as sa


revision = '20260428_097'
down_revision = '1285db6d3ce4'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('pricing_calculation_runs', sa.Column('platform_fee_usd', sa.Numeric(18, 2), nullable=True))


def downgrade() -> None:
    op.drop_column('pricing_calculation_runs', 'platform_fee_usd')