"""add screenshot fields to platform_revenues

Revision ID: 130
Revises: 129
Create Date: 2026-05-21
"""

from alembic import op
import sqlalchemy as sa

revision = '130'
down_revision = '129'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('platform_revenues', sa.Column('screenshot_r2_key', sa.String(512), nullable=True))
    op.add_column('platform_revenues', sa.Column('screenshot_r2_url', sa.String(1024), nullable=True))


def downgrade() -> None:
    op.drop_column('platform_revenues', 'screenshot_r2_url')
    op.drop_column('platform_revenues', 'screenshot_r2_key')
