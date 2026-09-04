"""backfill_shipping_price_from_raw_row

Revision ID: 20260429_112
Revises: 20260429_111
Create Date: 2026-04-29

Backfills shipping_price for historical sales order rows from the
raw_row JSON column, where the original Amazon CSV 'shipping-price'
field is preserved.
"""
from __future__ import annotations

from alembic import op


revision = '20260429_112'
down_revision = '20260429_111'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE analysis_sales_order_rows
        SET shipping_price = COALESCE(
            (raw_row->>'shipping-price')::numeric,
            0
        )
        WHERE shipping_price = 0
          AND raw_row->>'shipping-price' IS NOT NULL
          AND (raw_row->>'shipping-price')::numeric != 0
        """
    )


def downgrade() -> None:
    # No meaningful downgrade — just reset to 0
    op.execute(
        """
        UPDATE analysis_sales_order_rows
        SET shipping_price = 0
        WHERE shipping_price != 0
        """
    )
