"""add ai message search sources

Revision ID: 20260330_078
Revises: 20260330_077
Create Date: 2026-03-30 19:20:00
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260330_078'
down_revision: Union[str, None] = '20260330_077'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {column['name'] for column in inspector.get_columns('ai_messages')} if inspector.has_table('ai_messages') else set()

    if 'search_sources' not in columns:
        op.add_column('ai_messages', sa.Column('search_sources', sa.Text(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {column['name'] for column in inspector.get_columns('ai_messages')} if inspector.has_table('ai_messages') else set()

    if 'search_sources' in columns:
        op.drop_column('ai_messages', 'search_sources')
