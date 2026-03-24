"""add product_name (品名) to product_costs

Revision ID: 20260324_068
Revises: 20260324_067
Create Date: 2026-03-24 15:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260324_068"
down_revision: Union[str, None] = "20260324_067"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "product_costs",
        sa.Column(
            "product_name", sa.String(), nullable=True, comment="品名，运营人员手动维护"
        ),
    )


def downgrade() -> None:
    op.drop_column("product_costs", "product_name")
