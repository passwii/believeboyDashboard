"""新增 insight_run_observations 观测期指标表（BLF-1018）

Revision ID: 271
Revises: 270
Create Date: 2026-09-12 10:12:00.000000

Stage 5 观测期质量/成本门禁的落点表：按 run / capability 记录首字时延、总时长、
token 用量、重连次数、取消结果、Stream 体量、错误类型与降级事件。`insight_runs`
只承载业务状态，装不下传输与交互指标，故单独建表（不改旧表、不动旧读路径）。

表内只存可审计的结构化字段：system prompt、API key、base_url、原始 slot 一律
不落库（写入侧由 `app/services/insight/observation.py` 的字段白名单保证）。
`run_id` 唯一索引承担写入幂等；降级事件行 run_id 为空，两类行靠唯一索引对
NULL 的允许多次共存于同一张表。
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '271'
down_revision: Union[str, None] = '270'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'insight_run_observations',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False,
                  comment='主键'),
        sa.Column('source', sa.String(length=24), nullable=False,
                  server_default='insight_run',
                  comment='insight_run（终态 run 快照）/ legacy_fallback（降级事件）'),
        sa.Column('run_id', sa.String(length=36), nullable=True,
                  comment='Insight run_id；降级事件行为空'),
        sa.Column('attempt', sa.Integer(), nullable=True, comment='尝试代数'),
        sa.Column('capability', sa.String(length=64), nullable=False,
                  comment='聚合粗桶（insight / ad_analysis / ai_summary…）'),
        sa.Column('role_id', sa.String(length=128), nullable=True,
                  comment='聚合细桶角色 id'),
        sa.Column('endpoint_id', sa.String(length=64), nullable=True),
        sa.Column('model_id', sa.String(length=128), nullable=True),
        sa.Column('status', sa.String(length=32), nullable=True,
                  comment='终态状态；降级事件行为空'),
        sa.Column('first_delta_ms', sa.Integer(), nullable=True,
                  comment='attempt 起点 → 首个 content.delta 发布的毫秒数'),
        sa.Column('duration_ms', sa.Integer(), nullable=True, comment='总时长毫秒'),
        sa.Column('input_tokens', sa.Integer(), nullable=True),
        sa.Column('output_tokens', sa.Integer(), nullable=True),
        sa.Column('total_tokens', sa.Integer(), nullable=True),
        sa.Column('attempts', sa.Integer(), nullable=True),
        sa.Column('retries', sa.Integer(), nullable=True),
        sa.Column('stream_opens', sa.Integer(), nullable=False, server_default='0',
                  comment='SSE 订阅建立次数'),
        sa.Column('stream_reconnects', sa.Integer(), nullable=False, server_default='0',
                  comment='带游标重连次数'),
        sa.Column('stream_frames', sa.Integer(), nullable=False, server_default='0',
                  comment='已发布事件帧数'),
        sa.Column('stream_bytes', sa.Integer(), nullable=True,
                  comment='已发布载荷字节数'),
        sa.Column('stream_xlen', sa.Integer(), nullable=True, comment='快照时 XLEN'),
        sa.Column('stream_memory_bytes', sa.Integer(), nullable=True,
                  comment='快照时 MEMORY USAGE'),
        sa.Column('cancel_requested', sa.Boolean(), nullable=False,
                  server_default='false', comment='是否发起过取消'),
        sa.Column('cancel_succeeded', sa.Boolean(), nullable=True,
                  comment='取消是否成功落地'),
        sa.Column('error_code', sa.String(length=48), nullable=True,
                  comment='InsightErrorCode 值'),
        sa.Column('error_retryable', sa.Boolean(), nullable=True),
        sa.Column('fallback', sa.Boolean(), nullable=False, server_default='false',
                  comment='是否由非 canonical 路径服务'),
        sa.Column('fallback_reason', sa.String(length=128), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text('now()')),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text('now()')),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(
        'ix_insight_run_observations_run_id',
        'insight_run_observations',
        ['run_id'],
        unique=True,
    )
    op.create_index(
        'ix_insight_run_observations_capability',
        'insight_run_observations',
        ['capability', 'created_at'],
    )
    op.create_index(
        'ix_insight_run_observations_status',
        'insight_run_observations',
        ['status'],
    )


def downgrade() -> None:
    op.drop_index('ix_insight_run_observations_status',
                  table_name='insight_run_observations')
    op.drop_index('ix_insight_run_observations_capability',
                  table_name='insight_run_observations')
    op.drop_index('ix_insight_run_observations_run_id',
                  table_name='insight_run_observations')
    op.drop_table('insight_run_observations')
