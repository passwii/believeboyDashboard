"""scheduled_report_delivery_logs 新增 ai_summary_run_id 关联 Insight run（BLF-1014）

Revision ID: 270
Revises: 269
Create Date: 2026-09-11 11:04:17.155067

Stage 3 schedule report Insight adapter：`ai_summary_run_id` 指向
`insight_runs.run_id`（逻辑关联，不加外键——delivery_log 与 Insight run
生命周期各自独立，重试/重放不因外键互相阻塞删除）。`ai_summary_*` 既有
字段与响应口径保持不变，旧消费者零回归。
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '270'
down_revision: Union[str, None] = '269'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'scheduled_report_delivery_logs',
        sa.Column(
            'ai_summary_run_id',
            sa.String(length=36),
            nullable=True,
            comment='AI 摘要对应的 Insight run_id（schedule_report_summary.v1）',
        ),
    )
    op.create_index(
        'ix_delivery_logs_ai_summary_run',
        'scheduled_report_delivery_logs',
        ['ai_summary_run_id'],
    )


def downgrade() -> None:
    op.drop_index(
        'ix_delivery_logs_ai_summary_run',
        table_name='scheduled_report_delivery_logs',
    )
    op.drop_column('scheduled_report_delivery_logs', 'ai_summary_run_id')
