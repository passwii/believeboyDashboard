"""rename store_accounting to shop_calculation

Revision ID: 20260429_113
Revises: 20260429_112
Create Date: 2026-04-29 16:56:26.426161
"""
from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = '20260429_113'
down_revision: Union[str, None] = '20260429_112'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Rename the table
    op.rename_table('store_accounting', 'shop_calculation')

    # 2. Rename the sequence (auto-created by serial/identity columns)
    op.execute("ALTER SEQUENCE store_accounting_id_seq RENAME TO shop_calculation_id_seq")

    # 3. Rename primary key constraint
    op.execute("ALTER TABLE shop_calculation RENAME CONSTRAINT store_accounting_pkey TO shop_calculation_pkey")

    # 4. Rename unique constraint
    op.execute("ALTER TABLE shop_calculation RENAME CONSTRAINT uq_store_accounting_project_sku_country TO uq_shop_calculation_project_sku_country")

    # 5. Rename indexes
    op.execute("ALTER INDEX idx_store_accounting_country RENAME TO idx_shop_calculation_country")
    op.execute("ALTER INDEX idx_store_accounting_project_country RENAME TO idx_shop_calculation_project_country")
    op.execute("ALTER INDEX idx_store_accounting_project_id RENAME TO idx_shop_calculation_project_id")
    op.execute("ALTER INDEX idx_store_accounting_updated_at RENAME TO idx_shop_calculation_updated_at")


def downgrade() -> None:
    # 5. Rename indexes back
    op.execute("ALTER INDEX idx_shop_calculation_updated_at RENAME TO idx_store_accounting_updated_at")
    op.execute("ALTER INDEX idx_shop_calculation_project_id RENAME TO idx_store_accounting_project_id")
    op.execute("ALTER INDEX idx_shop_calculation_project_country RENAME TO idx_store_accounting_project_country")
    op.execute("ALTER INDEX idx_shop_calculation_country RENAME TO idx_store_accounting_country")

    # 4. Rename unique constraint back
    op.execute("ALTER TABLE shop_calculation RENAME CONSTRAINT uq_shop_calculation_project_sku_country TO uq_store_accounting_project_sku_country")

    # 3. Rename primary key constraint back
    op.execute("ALTER TABLE shop_calculation RENAME CONSTRAINT shop_calculation_pkey TO store_accounting_pkey")

    # 2. Rename the sequence back
    op.execute("ALTER SEQUENCE shop_calculation_id_seq RENAME TO store_accounting_id_seq")

    # 1. Rename the table back
    op.rename_table('shop_calculation', 'store_accounting')
