"""add user_id to ai_conversations

Revision ID: 162
Revises: 161
Create Date: 2026-06-14 12:00:00.000000
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = '162'
down_revision: Union[str, None] = '161'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'ai_conversations',
        sa.Column('user_id', sa.BigInteger(), nullable=True),
    )
    op.create_index(
        'ix_ai_conversations_user_id',
        'ai_conversations',
        ['user_id'],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index('ix_ai_conversations_user_id', table_name='ai_conversations')
    op.drop_column('ai_conversations', 'user_id')
