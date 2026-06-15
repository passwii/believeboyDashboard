"""add search_time_range to ai_messages

[BEL-81.B] 让搜索结果卡片可在刷新后回放时间范围 chip。

设计：
- 新增 `search_time_range` 列（String(16), nullable），存 `day|week|month|year|all`
  之一（后端 `detect_time_range_from_query` / tool 调用 `time_range` 透传）
- 列上不设 CHECK 约束以保持与现有 SQLite/PG 兼容，与 `search_sources`
  字段同样的存值风格（应用层校验）
- 历史数据全部为 NULL，前端读取时按"未指定"处理（即不显示 chip）
- 不存 `search_query`：tool 调用时的 query 已写入 search_sources 中的
  context，且 AIMessage.content 包含用户原始问题；不重复持久化

Revision ID: 163
Revises: 162
Create Date: 2026-06-14 14:00:00.000000
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = '163'
down_revision: Union[str, None] = '162'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'ai_messages',
        sa.Column('search_time_range', sa.String(length=16), nullable=True),
    )


def downgrade() -> None:
    op.drop_column('ai_messages', 'search_time_range')
