"""Add sub_status column to ai_insights for granular generation progress

Revision ID: 20260416_096
Revises: 20260415_095b
Create Date: 2026-04-16
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '20260416_096'
down_revision: Union[str, Sequence[str], None] = '20260415_095b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'ai_insights',
        sa.Column('sub_status', sa.String(length=32), nullable=True),
    )


def downgrade() -> None:
    op.drop_column('ai_insights', 'sub_status')
