"""create_r2_delete_failures

Revision ID: 20260629_201
Revises: 20260627_200
Create Date: 2026-06-29

新增表：r2_delete_failures
记录 R2 删除失败的死信队列，cron 兜底重试用 (P3.2 retry_r2_dead_letters.py)。

理由：P1/P2 阶段 R2 删除是同步调用，失败时不抛错以避免阻塞业务，
但是如果 R2 暂时不可用，挂账的对象必须有地方保存，否则永远成孤儿。
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


revision = '20260629_201'
down_revision = '20260627_200'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'r2_delete_failures',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('r2_key', sa.Text(), nullable=False),
        sa.Column('error_class', sa.String(length=128), nullable=True),
        sa.Column('error_message', sa.Text(), nullable=True),
        sa.Column('source', sa.String(length=64), nullable=False),
        sa.Column('context_json', JSONB, nullable=True),
        sa.Column('retry_count', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('last_retry_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('resolved_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_via_hook', sa.Boolean(), nullable=False, server_default=sa.text('false')),
        sa.Column('attempted_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('NOW()')),
    )
    # 部分索引：未解决行 (resolved_at IS NULL) 是热路径，运维 90% 的查询是这个。
    # 顺序: attempted_at asc 让 retry 脚本优先处理最早的脏数据。
    op.create_index(
        'idx_r2_delete_failures_unresolved',
        'r2_delete_failures',
        ['attempted_at'],
        postgresql_where=sa.text('resolved_at IS NULL'),
    )
    # 监控需要的另一个 index: 按 source 统计死信数量
    op.create_index(
        'idx_r2_delete_failures_source',
        'r2_delete_failures',
        ['source'],
    )


def downgrade() -> None:
    op.drop_index('idx_r2_delete_failures_source', table_name='r2_delete_failures')
    op.drop_index('idx_r2_delete_failures_unresolved', table_name='r2_delete_failures')
    op.drop_table('r2_delete_failures')
