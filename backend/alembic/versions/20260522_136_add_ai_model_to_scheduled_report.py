"""Add ai_model column to scheduled_report_subscriptions.

Revision ID: 136
Revises: 135
Create Date: 2026-05-22
"""

from alembic import op
import sqlalchemy as sa

revision = '136'
down_revision = '135'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        'scheduled_report_subscriptions',
        sa.Column('ai_model', sa.String(64), nullable=True, comment='AI 摘要使用的模型，空则用默认模型'),
    )


def downgrade() -> None:
    op.drop_column('scheduled_report_subscriptions', 'ai_model')
