"""add_is_active_to_projects

Revision ID: 20260415_095
Revises: 20260414_094_create_store_accounting_table
Create Date: 2026-04-15

"""
from alembic import op
import sqlalchemy as sa


revision = '20260415_095'
down_revision = '20260414_094'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('projects', sa.Column('is_active', sa.Boolean(), nullable=False, server_default='true'))


def downgrade() -> None:
    op.drop_column('projects', 'is_active')
