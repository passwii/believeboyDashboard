"""add assistant_operator field to projects

Revision ID: 20260302_016
Revises: 20260302_015
Create Date: 2026-03-02 18:20:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260302_016'
down_revision: Union[str, None] = '20260302_015'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_column(inspector: sa.Inspector, table_name: str, column_name: str) -> bool:
    return column_name in {column['name'] for column in inspector.get_columns(table_name)}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table('projects') and _has_column(inspector, 'projects', 'assistant_operator') is False:
        op.add_column('projects', sa.Column('assistant_operator', sa.String(length=255), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table('projects') and _has_column(inspector, 'projects', 'assistant_operator'):
        op.drop_column('projects', 'assistant_operator')
