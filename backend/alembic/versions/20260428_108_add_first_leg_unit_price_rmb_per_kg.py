"""add first_leg_unit_price_rmb_per_kg to pricing_calculation_runs

Revision ID: 20260428_108
Revises: 20260427_106
Create Date: 2026-04-28 10:20:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260428_108'
down_revision: Union[str, None] = '20260427_106'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'pricing_calculation_runs',
        sa.Column('first_leg_unit_price_rmb_per_kg', sa.Numeric(18, 4), nullable=True)
    )


def downgrade() -> None:
    op.drop_column('pricing_calculation_runs', 'first_leg_unit_price_rmb_per_kg')