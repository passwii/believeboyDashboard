"""新增独立 Insight durable run 表 insight_runs（BLF-1011）

Revision ID: 269
Revises: 268
Create Date: 2026-09-10 00:00:00.000000

新 Insight 基础设施的 durable run 记录：幂等 key、attempt、状态时间线、
role/version、endpoint/model、usage、最终 Markdown、typed error、duration。
不修改旧 ai_insights 表。
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '269'
down_revision: Union[str, None] = '268'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'insight_runs',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('run_id', sa.String(length=36), nullable=False),
        sa.Column('attempt', sa.Integer(), nullable=False, server_default='1'),
        sa.Column('capability', sa.String(length=64), nullable=False, server_default='insight'),
        sa.Column('use_case', sa.String(length=128), nullable=False),
        sa.Column('project_id', sa.Integer(), nullable=False),
        sa.Column('country', sa.String(length=2), nullable=False),
        sa.Column('role_id', sa.String(length=128), nullable=False),
        sa.Column('role_version', sa.Integer(), nullable=False),
        sa.Column('endpoint_id', sa.String(length=64), nullable=False),
        sa.Column('model_id', sa.String(length=128), nullable=False),
        sa.Column('status', sa.String(length=32), nullable=False, server_default='queued'),
        sa.Column('stage', sa.String(length=32), nullable=False, server_default='queued'),
        sa.Column('progress_percent', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('idempotency_key', sa.String(length=64), nullable=False),
        sa.Column('request_fingerprint', sa.String(length=64), nullable=False),
        sa.Column('slots_json', sa.Text(), nullable=False, server_default='{}'),
        sa.Column('status_timeline_json', sa.Text(), nullable=False, server_default='[]'),
        sa.Column('usage_json', sa.Text(), nullable=True),
        sa.Column('outputs_json', sa.Text(), nullable=True),
        sa.Column('content_markdown', sa.Text(), nullable=True),
        sa.Column('error_json', sa.Text(), nullable=True),
        sa.Column('duration_ms', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('completed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            'updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False
        ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint(
            'project_id', 'country', 'idempotency_key',
            name='uq_insight_runs_scope_idempotency',
        ),
    )
    op.create_index('ix_insight_runs_run_id', 'insight_runs', ['run_id'], unique=True)
    op.create_index('ix_insight_runs_scope', 'insight_runs', ['project_id', 'country'])
    op.create_index('ix_insight_runs_status', 'insight_runs', ['status'])


def downgrade() -> None:
    op.drop_index('ix_insight_runs_status', table_name='insight_runs')
    op.drop_index('ix_insight_runs_scope', table_name='insight_runs')
    op.drop_index('ix_insight_runs_run_id', table_name='insight_runs')
    op.drop_table('insight_runs')
