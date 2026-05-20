"""backfill_is_active_true

Revision ID: 20260415_095b
Revises: 20260415_095
Branch: None
Create Date: 2026-04-15

"""
from alembic import op


revision = '20260415_095b'
down_revision = '20260415_095'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # server_default only applies to new inserts; backfill existing rows
    op.execute("UPDATE projects SET is_active = true WHERE is_active IS NOT true")


def downgrade() -> None:
    pass
