"""pricing_calculation_runs add project_id and sku columns

Revision ID: 050
Revises: 049
Create Date: 2026-03-14 10:37:00.000000

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '20260314_050'
down_revision = '20260314_049'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 添加 project_id 列 (可空，带索引)
    op.add_column(
        'pricing_calculation_runs',
        sa.Column('project_id', sa.BigInteger(), nullable=True, index=True)
    )
    # 添加 sku 列 (可空，带索引)
    op.add_column(
        'pricing_calculation_runs',
        sa.Column('sku', sa.String(100), nullable=True, index=True)
    )


def downgrade() -> None:
    op.drop_column('pricing_calculation_runs', 'sku')
    op.drop_column('pricing_calculation_runs', 'project_id')
