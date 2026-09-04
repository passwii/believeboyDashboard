"""add_platform_fee_to_store_accounting

Revision ID: 20260428_109
Revises: 20260428_108
Create Date: 2026-04-28

"""
from alembic import op
import sqlalchemy as sa


revision = '20260428_109'
down_revision = '20260428_108'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('store_accounting', sa.Column('platform_fee_usd', sa.Numeric(18, 2), nullable=False, server_default='0.00'))


def downgrade() -> None:
    op.drop_column('store_accounting', 'platform_fee_usd')