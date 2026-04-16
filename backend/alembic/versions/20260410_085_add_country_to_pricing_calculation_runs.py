"""add country to pricing_calculation_runs

Revision ID: 20260410_085
Revises: 20260409_084
Create Date: 2026-04-10 17:15:39.190250
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '20260410_085'
down_revision: Union[str, None] = '20260409_084'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'pricing_calculation_runs',
        sa.Column('country', sa.String(length=10), server_default='US', nullable=False),
    )
    op.create_index(
        op.f('ix_pricing_calculation_runs_country'),
        'pricing_calculation_runs',
        ['country'],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        op.f('ix_pricing_calculation_runs_country'),
        table_name='pricing_calculation_runs',
    )
    op.drop_column('pricing_calculation_runs', 'country')
