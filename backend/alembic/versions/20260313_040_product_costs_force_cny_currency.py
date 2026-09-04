"""force product costs currency to cny

Revision ID: 20260313_040
Revises: 20260312_039
Create Date: 2026-03-13 12:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '20260313_040'
down_revision = '20260312_039'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("UPDATE product_costs SET currency = 'CNY' WHERE currency IS NULL OR currency <> 'CNY'")
    op.alter_column(
        'product_costs',
        'currency',
        existing_type=sa.String(),
        server_default='CNY',
        existing_nullable=False,
    )


def downgrade() -> None:
    op.alter_column(
        'product_costs',
        'currency',
        existing_type=sa.String(),
        server_default='USD',
        existing_nullable=False,
    )
