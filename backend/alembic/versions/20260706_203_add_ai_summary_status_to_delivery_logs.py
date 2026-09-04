"""add_ai_summary_status_to_delivery_logs

Revision ID: 20260706_203
Revises: 20260706_202
Create Date: 2026-07-06

拆分 scheduled report 主任务与 AI 摘要任务状态。
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = '20260706_203'
down_revision = '20260706_202'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        'scheduled_report_delivery_logs',
        sa.Column(
            'ai_summary_status',
            sa.String(length=20),
            nullable=False,
            server_default='pending',
            comment='AI 摘要状态: pending/generating/done/failed',
        ),
    )
    op.add_column(
        'scheduled_report_delivery_logs',
        sa.Column('ai_summary_error', sa.Text(), nullable=True, comment='AI 摘要生成错误'),
    )
    op.add_column(
        'scheduled_report_delivery_logs',
        sa.Column('ai_summary_model', sa.String(length=64), nullable=True, comment='AI 摘要使用模型'),
    )
    op.add_column(
        'scheduled_report_delivery_logs',
        sa.Column('ai_summary_updated_at', sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        'ix_scheduled_report_delivery_logs_ai_summary_status',
        'scheduled_report_delivery_logs',
        ['ai_summary_status'],
    )

    op.execute(
        "UPDATE scheduled_report_delivery_logs "
        "SET ai_summary_status = 'done', ai_summary_updated_at = COALESCE(sent_at, created_at) "
        "WHERE ai_summary IS NOT NULL AND btrim(ai_summary) <> ''"
    )


def downgrade() -> None:
    op.drop_index(
        'ix_scheduled_report_delivery_logs_ai_summary_status',
        table_name='scheduled_report_delivery_logs',
    )
    op.drop_column('scheduled_report_delivery_logs', 'ai_summary_updated_at')
    op.drop_column('scheduled_report_delivery_logs', 'ai_summary_model')
    op.drop_column('scheduled_report_delivery_logs', 'ai_summary_error')
    op.drop_column('scheduled_report_delivery_logs', 'ai_summary_status')
