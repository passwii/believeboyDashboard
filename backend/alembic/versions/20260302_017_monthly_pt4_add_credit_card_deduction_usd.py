"""add credit_card_deduction_usd to monthly_report_pt4_calculation

Revision ID: 20260302_017
Revises: 20260302_016
Create Date: 2026-03-02 19:10:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260302_017'
down_revision: Union[str, None] = '20260302_016'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_column(inspector: sa.Inspector, table_name: str, column_name: str) -> bool:
    return column_name in {column['name'] for column in inspector.get_columns(table_name)}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if _has_column(inspector, 'monthly_report_pt4_calculation', 'credit_card_deduction_usd') is False:
        op.add_column(
            'monthly_report_pt4_calculation',
            sa.Column('credit_card_deduction_usd', sa.Numeric(18, 2), nullable=False, server_default=sa.text('0')),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if _has_column(inspector, 'monthly_report_pt4_calculation', 'credit_card_deduction_usd'):
        op.drop_column('monthly_report_pt4_calculation', 'credit_card_deduction_usd')
