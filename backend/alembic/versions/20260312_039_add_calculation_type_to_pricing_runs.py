"""add calculation type to pricing calculation runs

Revision ID: 20260312_039
Revises: 20260312_038
Create Date: 2026-03-12 18:20:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260312_039'
down_revision: Union[str, None] = '20260312_038'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if 'pricing_calculation_runs' not in inspector.get_table_names():
        return

    columns = {column['name'] for column in inspector.get_columns('pricing_calculation_runs')}
    if 'calculation_type' in columns:
        return

    op.add_column(
        'pricing_calculation_runs',
        sa.Column('calculation_type', sa.String(length=32), nullable=False, server_default='profit_calc'),
    )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if 'pricing_calculation_runs' not in inspector.get_table_names():
        return

    columns = {column['name'] for column in inspector.get_columns('pricing_calculation_runs')}
    if 'calculation_type' not in columns:
        return

    op.drop_column('pricing_calculation_runs', 'calculation_type')
