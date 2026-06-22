"""add competitor_url to pricing_calculation_runs

Revision ID: 20260622_167
Revises: 20260618_166
Create Date: 2026-06-22 12:00:00.000000

Adds competitor_url column to pricing_calculation_runs. Stores the
competitor listing URL (Amazon / competitor product page, http(s)://
prefix required, max 1000 chars). The frontend "测算输入" form exposes
the field; only the "测算对比矩阵" Excel export surfaces it in the UI.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '20260622_167'
down_revision: Union[str, None] = '20260618_166'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'pricing_calculation_runs',
        sa.Column(
            'competitor_url',
            sa.String(length=1000),
            nullable=True,
            comment='竞品链接（Amazon/竞品 listing URL，http(s):// 开头，最长 1000 字符）',
        ),
    )


def downgrade() -> None:
    op.drop_column('pricing_calculation_runs', 'competitor_url')
