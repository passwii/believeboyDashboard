"""add_vat_and_eu_fields_to_pricing

Revision ID: 20260410_087
Revises: 20260410_086
Create Date: 2026-04-10
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '20260410_087'
down_revision: Union[str, None] = '20260410_086'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # pricing_calculation_runs: add VAT fields
    op.add_column(
        'pricing_calculation_runs',
        sa.Column('vat_usd', sa.Numeric(18, 2), nullable=False, server_default='0.00'),
    )
    op.add_column(
        'pricing_calculation_runs',
        sa.Column('profit_after_vat_usd', sa.Numeric(18, 2), nullable=True),
    )
    op.add_column(
        'pricing_calculation_runs',
        sa.Column('profit_after_vat_rate', sa.Numeric(8, 6), nullable=True),
    )

    # store_sku_pricing_snapshots: add EU manual fee fields and VAT
    op.add_column(
        'store_sku_pricing_snapshots',
        sa.Column('delivery_fee_usd', sa.Numeric(18, 2), nullable=False, server_default='0.00'),
    )
    op.add_column(
        'store_sku_pricing_snapshots',
        sa.Column('inbound_config_fee_manual_usd', sa.Numeric(18, 2), nullable=False, server_default='0.00'),
    )
    op.add_column(
        'store_sku_pricing_snapshots',
        sa.Column('storage_fee_manual_usd', sa.Numeric(18, 2), nullable=False, server_default='0.00'),
    )
    op.add_column(
        'store_sku_pricing_snapshots',
        sa.Column('vat_usd', sa.Numeric(18, 2), nullable=False, server_default='0.00'),
    )
    op.add_column(
        'store_sku_pricing_snapshots',
        sa.Column('profit_after_vat_usd', sa.Numeric(18, 2), nullable=True),
    )
    op.add_column(
        'store_sku_pricing_snapshots',
        sa.Column('profit_after_vat_rate', sa.Numeric(8, 6), nullable=True),
    )


def downgrade() -> None:
    op.drop_column('store_sku_pricing_snapshots', 'profit_after_vat_rate')
    op.drop_column('store_sku_pricing_snapshots', 'profit_after_vat_usd')
    op.drop_column('store_sku_pricing_snapshots', 'vat_usd')
    op.drop_column('store_sku_pricing_snapshots', 'storage_fee_manual_usd')
    op.drop_column('store_sku_pricing_snapshots', 'inbound_config_fee_manual_usd')
    op.drop_column('store_sku_pricing_snapshots', 'delivery_fee_usd')
    op.drop_column('pricing_calculation_runs', 'profit_after_vat_rate')
    op.drop_column('pricing_calculation_runs', 'profit_after_vat_usd')
    op.drop_column('pricing_calculation_runs', 'vat_usd')
