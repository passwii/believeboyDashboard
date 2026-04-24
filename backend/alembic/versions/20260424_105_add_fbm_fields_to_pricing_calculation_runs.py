"""add fbm fields to pricing_calculation_runs

Revision ID: 4bc3ae3b753b
Revises: 20260423_104
Create Date: 2026-04-24 15:20:06.029840
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '4bc3ae3b753b'
down_revision: Union[str, None] = '20260423_104'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'pricing_calculation_runs',
        sa.Column('delivery_fee_usd', sa.Numeric(precision=18, scale=2), nullable=True),
    )
    op.add_column(
        'pricing_calculation_runs',
        sa.Column('full_container_quantity', sa.Numeric(precision=18, scale=4), nullable=True),
    )
    op.add_column(
        'pricing_calculation_runs',
        sa.Column('full_container_price_rmb', sa.Numeric(precision=18, scale=2), nullable=True),
    )


def downgrade() -> None:
    op.drop_column('pricing_calculation_runs', 'full_container_price_rmb')
    op.drop_column('pricing_calculation_runs', 'full_container_quantity')
    op.drop_column('pricing_calculation_runs', 'delivery_fee_usd')
