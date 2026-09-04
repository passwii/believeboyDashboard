"""create inventory replenishment snapshot tables

Revision ID: 20260516_121
Revises: 20260514_120
Create Date: 2026-05-16 00:00:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260516_121'
down_revision: Union[str, None] = '20260514_120'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Create snapshot header table
    op.create_table(
        'inventory_replenishment_snapshots',
        sa.Column('id', sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column('project_id', sa.BigInteger(), sa.ForeignKey('projects.id', ondelete='CASCADE'), nullable=False),
        sa.Column('project_name', sa.String(255), nullable=False),
        sa.Column('country', sa.String(2), nullable=False, server_default='US'),
        sa.Column('snapshot_date', sa.Date(), nullable=False),
        sa.Column('is_current', sa.Boolean(), nullable=False, server_default='false'),
        sa.Column('inventory_report_date', sa.Date(), nullable=True),
        sa.Column('business_report_date', sa.Date(), nullable=True),
        sa.Column('sales_report_date', sa.Date(), nullable=True),
        sa.Column('name', sa.String(255), nullable=True),
        sa.Column('description', sa.String(512), nullable=True),
        sa.Column('summary_json', sa.JSON(), nullable=False, server_default='{}'),
        sa.Column('row_count', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('computation_time_ms', sa.Integer(), nullable=True),
        sa.Column('created_by', sa.String(255), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )

    # Create unique constraint
    op.create_unique_constraint(
        'uq_inventory_replenishment_snapshot_project_country_date',
        'inventory_replenishment_snapshots',
        ['project_id', 'country', 'snapshot_date'],
    )

    # Create indexes
    op.create_index('idx_inventory_replenishment_snapshots_project_id', 'inventory_replenishment_snapshots', ['project_id'])
    op.create_index('idx_inventory_replenishment_snapshots_project_country', 'inventory_replenishment_snapshots', ['project_id', 'country'])
    op.create_index('idx_inventory_replenishment_snapshots_date', 'inventory_replenishment_snapshots', ['snapshot_date'])

    # Create snapshot items table
    op.create_table(
        'inventory_replenishment_snapshot_items',
        sa.Column('id', sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column('snapshot_id', sa.BigInteger(), sa.ForeignKey('inventory_replenishment_snapshots.id', ondelete='CASCADE'), nullable=False),
        sa.Column('source_row_no', sa.Integer(), nullable=False),
        sa.Column('sku', sa.String(128), nullable=False),
        sa.Column('asin', sa.String(64), nullable=True),
        sa.Column('available_inventory', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('in_transit_quantity', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('dms_30', sa.Numeric(18, 6), nullable=True),
        sa.Column('dms_14', sa.Numeric(18, 6), nullable=True),
        sa.Column('dms_7', sa.Numeric(18, 6), nullable=True),
        sa.Column('dms_3', sa.Numeric(18, 6), nullable=True),
        sa.Column('base_dms', sa.Numeric(18, 6), nullable=True),
        sa.Column('safety_factor', sa.Numeric(8, 4), nullable=False, server_default='0.20'),
        sa.Column('production_lead_days', sa.Integer(), nullable=False, server_default='20'),
        sa.Column('shipping_days', sa.Integer(), nullable=False, server_default='25'),
        sa.Column('weighted_dms', sa.Numeric(18, 6), nullable=True),
        sa.Column('sellable_days', sa.Numeric(18, 4), nullable=True),
        sa.Column('sellout_date', sa.String(32), nullable=True),
        sa.Column('sellout_date_with_transit', sa.String(32), nullable=True),
        sa.Column('replenishment_order_date', sa.String(32), nullable=True),
        sa.Column('warehouse_entry_date', sa.String(32), nullable=True),
        sa.Column('shipment_order_date', sa.String(32), nullable=True),
        sa.Column('estimated_replenishment_quantity', sa.Integer(), nullable=True),
        sa.Column('risk_status', sa.String(32), nullable=False),
        sa.Column('risk_anchor_date', sa.String(32), nullable=True),
    )

    # Create indexes for items table
    op.create_index('idx_inventory_replenishment_snapshot_items_snapshot_id', 'inventory_replenishment_snapshot_items', ['snapshot_id'])
    op.create_index('idx_inventory_replenishment_snapshot_items_sku', 'inventory_replenishment_snapshot_items', ['snapshot_id', 'sku'])


def downgrade() -> None:
    op.drop_index('idx_inventory_replenishment_snapshot_items_sku', table_name='inventory_replenishment_snapshot_items')
    op.drop_index('idx_inventory_replenishment_snapshot_items_snapshot_id', table_name='inventory_replenishment_snapshot_items')
    op.drop_table('inventory_replenishment_snapshot_items')
    op.drop_index('idx_inventory_replenishment_snapshots_date', table_name='inventory_replenishment_snapshots')
    op.drop_index('idx_inventory_replenishment_snapshots_project_country', table_name='inventory_replenishment_snapshots')
    op.drop_index('idx_inventory_replenishment_snapshots_project_id', table_name='inventory_replenishment_snapshots')
    op.drop_constraint('uq_inventory_replenishment_snapshot_project_country_date', 'inventory_replenishment_snapshots', type_='unique')
    op.drop_table('inventory_replenishment_snapshots')