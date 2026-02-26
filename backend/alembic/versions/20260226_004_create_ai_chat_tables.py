"""create ai chat tables

Revision ID: 20260226_004
Revises: 20260225_003
Create Date: 2026-02-26 16:00:00
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260226_004'
down_revision: Union[str, None] = '20260225_003'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table('ai_conversations'):
        op.create_table(
            'ai_conversations',
            sa.Column('id', sa.Integer(), nullable=False),
            sa.Column('title', sa.String(length=255), nullable=False),
            sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('CURRENT_TIMESTAMP'), nullable=False),
            sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('CURRENT_TIMESTAMP'), nullable=False),
            sa.PrimaryKeyConstraint('id'),
        )

    if not inspector.has_table('ai_messages'):
        op.create_table(
            'ai_messages',
            sa.Column('id', sa.Integer(), nullable=False),
            sa.Column('conversation_id', sa.Integer(), nullable=False),
            sa.Column('role', sa.String(length=32), nullable=False),
            sa.Column('content', sa.Text(), nullable=False),
            sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('CURRENT_TIMESTAMP'), nullable=False),
            sa.ForeignKeyConstraint(['conversation_id'], ['ai_conversations.id'], ondelete='CASCADE'),
            sa.PrimaryKeyConstraint('id'),
        )

    op.execute('create index if not exists ix_ai_messages_conversation_id on ai_messages (conversation_id)')


def downgrade() -> None:
    op.execute('drop index if exists ix_ai_messages_conversation_id')
    op.execute('drop table if exists ai_messages')
    op.execute('drop table if exists ai_conversations')
