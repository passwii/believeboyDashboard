"""客诉明细新增对话级别字段 first_message_date / message_count / messages（BLF-1004）

Revision ID: 266
Revises: 265
Create Date: 2026-09-09 00:00:00.000000

与 complaints Dashboard 契约配套：列表/详情响应返回 first_message_date、
message_count、messages，前端映射层直接消费。
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '266'
down_revision: Union[str, None] = '265'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('complaints', sa.Column('first_message_date', sa.Date(), nullable=True))
    op.add_column(
        'complaints',
        sa.Column('message_count', sa.Integer(), nullable=False, server_default='1'),
    )
    op.add_column(
        'complaints',
        sa.Column('messages', sa.JSON(), nullable=False, server_default='[]'),
    )
    op.execute('UPDATE complaints SET first_message_date = message_date WHERE first_message_date IS NULL')
    op.alter_column('complaints', 'first_message_date', existing_type=sa.Date(), nullable=False)
    op.create_index('idx_complaints_first_message_date', 'complaints', ['first_message_date'])


def downgrade() -> None:
    op.drop_index('idx_complaints_first_message_date', table_name='complaints')
    op.drop_column('complaints', 'messages')
    op.drop_column('complaints', 'message_count')
    op.drop_column('complaints', 'first_message_date')
