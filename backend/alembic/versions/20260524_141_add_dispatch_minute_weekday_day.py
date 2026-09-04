"""Add dispatch_minute, dispatch_weekday, dispatch_day to subscriptions.

Revision ID: 141
Revises: 140
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = '141'
down_revision = '140'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        'scheduled_report_subscriptions',
        sa.Column('dispatch_minute', sa.Integer(), nullable=False, server_default='0',
                  comment='发送时间（分钟，0-59）'),
    )
    op.add_column(
        'scheduled_report_subscriptions',
        sa.Column('dispatch_weekday', sa.Integer(), nullable=True,
                  comment='周报发送日（0=周一..6=周日），仅 weekly 使用'),
    )
    op.add_column(
        'scheduled_report_subscriptions',
        sa.Column('dispatch_day', sa.Integer(), nullable=True,
                  comment='月报发送日（2-28），仅 monthly 使用'),
    )


def downgrade() -> None:
    op.drop_column('scheduled_report_subscriptions', 'dispatch_day')
    op.drop_column('scheduled_report_subscriptions', 'dispatch_weekday')
    op.drop_column('scheduled_report_subscriptions', 'dispatch_minute')
