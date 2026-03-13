"""add full_name field to user_accounts

Revision ID: 20260302_015
Revises: 20260228_014
Create Date: 2026-03-02 10:30:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260302_015'
down_revision: Union[str, None] = '20260228_014'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_column(inspector: sa.Inspector, table_name: str, column_name: str) -> bool:
    return column_name in {column['name'] for column in inspector.get_columns(table_name)}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table('user_accounts') and _has_column(inspector, 'user_accounts', 'full_name') is False:
        op.add_column('user_accounts', sa.Column('full_name', sa.Text(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table('user_accounts') and _has_column(inspector, 'user_accounts', 'full_name'):
        op.drop_column('user_accounts', 'full_name')
