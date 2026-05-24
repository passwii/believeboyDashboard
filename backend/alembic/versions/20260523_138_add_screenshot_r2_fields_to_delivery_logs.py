"""Add screenshot R2 key and URL to scheduled report delivery logs."""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = '138'
down_revision = '137'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        'scheduled_report_delivery_logs',
        sa.Column('screenshot_r2_key', sa.String(512), nullable=True, comment='R2 object key for screenshot'),
    )
    op.add_column(
        'scheduled_report_delivery_logs',
        sa.Column('screenshot_r2_url', sa.String(1024), nullable=True, comment='Public URL for screenshot'),
    )


def downgrade() -> None:
    op.drop_column('scheduled_report_delivery_logs', 'screenshot_r2_url')
    op.drop_column('scheduled_report_delivery_logs', 'screenshot_r2_key')