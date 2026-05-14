"""Add factory_info JSON column and audit fields to product_costs

Revision ID: 20260514_119
Revises: 20260513_118
Create Date: 2026-05-14 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260514_119'
down_revision: Union[str, Sequence[str], None] = '20260513_118'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'product_costs',
        sa.Column('factory_info', sa.JSON(), nullable=True),
    )
    op.add_column(
        'product_costs',
        sa.Column('factory_info_updated_at', sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        'product_costs',
        sa.Column('factory_info_updated_by', sa.String(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column('product_costs', 'factory_info_updated_by')
    op.drop_column('product_costs', 'factory_info_updated_at')
    op.drop_column('product_costs', 'factory_info')
