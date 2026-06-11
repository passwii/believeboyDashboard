"""add expense_vat_total to PT4 calculation table

Revision ID: 161
Revises: 160
Create Date: 2026-06-11 18:00:00.000000
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = '161'
down_revision: Union[str, None] = '160'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'monthly_report_pt4_calculation',
        sa.Column('expense_vat_total', sa.Numeric(18, 2), nullable=False, server_default='0'),
    )


def downgrade() -> None:
    op.drop_column('monthly_report_pt4_calculation', 'expense_vat_total')
