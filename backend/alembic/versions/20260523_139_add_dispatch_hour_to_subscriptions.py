"""Add dispatch_hour to scheduled report subscriptions."""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = '139'
down_revision = '138'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        'scheduled_report_subscriptions',
        sa.Column(
            'dispatch_hour',
            sa.Integer(),
            nullable=False,
            server_default=sa.text('15'),
            comment='发送时间（小时，0-23，北京时间）',
        ),
    )


def downgrade() -> None:
    op.drop_column('scheduled_report_subscriptions', 'dispatch_hour')
