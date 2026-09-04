"""add revenue_type to platform_revenues

Revision ID: 128
Revises: 127
Create Date: 2026-05-20
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '128'
down_revision: Union[str, None] = '127'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'platform_revenues',
        sa.Column('revenue_type', sa.String(length=20), nullable=False, server_default='订单回款'),
    )
    # Remove server_default after backfill
    op.alter_column('platform_revenues', 'revenue_type', server_default=None)


def downgrade() -> None:
    op.drop_column('platform_revenues', 'revenue_type')
