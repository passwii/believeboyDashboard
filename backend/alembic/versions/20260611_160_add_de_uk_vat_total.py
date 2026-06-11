"""add DE/UK VAT total columns to monthly report PT3/PT4

Revision ID: 160
Revises: 159
Create Date: 2026-06-11 17:00:00.000000
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = '160'
down_revision: Union[str, None] = '159'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'monthly_report_pt3_calculation',
        sa.Column('income_vat_total', sa.Numeric(18, 2), nullable=False, server_default='0'),
    )
    op.add_column(
        'monthly_report_pt3_calculation',
        sa.Column('income_sales_with_tax', sa.Numeric(18, 2), nullable=False, server_default='0'),
    )
    op.add_column(
        'monthly_report_pt4_calculation',
        sa.Column('expense_vat_total', sa.Numeric(18, 2), nullable=False, server_default='0'),
    )


def downgrade() -> None:
    op.drop_column('monthly_report_pt4_calculation', 'expense_vat_total')
    op.drop_column('monthly_report_pt3_calculation', 'income_sales_with_tax')
    op.drop_column('monthly_report_pt3_calculation', 'income_vat_total')
