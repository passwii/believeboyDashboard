"""Add ai_summary field to scheduled report delivery logs.

Revision ID: 140
Revises: 139
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = '140'
down_revision = '139'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        'scheduled_report_delivery_logs',
        sa.Column('ai_summary', sa.Text(), nullable=True, comment='AI 报表总结文案（Markdown）')
    )


def downgrade() -> None:
    op.drop_column('scheduled_report_delivery_logs', 'ai_summary')