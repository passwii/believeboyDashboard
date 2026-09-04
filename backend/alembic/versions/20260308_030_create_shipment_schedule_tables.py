"""create shipment schedule tables

Revision ID: 20260308_030
Revises: 20260308_029
Create Date: 2026-03-08 21:35:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260308_030'
down_revision: Union[str, None] = '20260308_029'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

BIGINT_SQLITE = sa.BigInteger().with_variant(sa.Integer(), 'sqlite')


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table('shipment_schedules'):
        op.create_table(
            'shipment_schedules',
            sa.Column('id', BIGINT_SQLITE, primary_key=True, autoincrement=True),
            sa.Column('project_id', BIGINT_SQLITE, nullable=False),
            sa.Column('project_name_snapshot', sa.String(length=255), nullable=False),
            sa.Column('shipment_no', sa.String(length=100), nullable=False),
            sa.Column('tracking_no', sa.String(length=100), nullable=True),
            sa.Column('warehouse_code', sa.String(length=100), nullable=True),
            sa.Column('supplier_name', sa.String(length=100), nullable=True),
            sa.Column('forwarder_name', sa.String(length=100), nullable=True),
            sa.Column('shipping_method', sa.String(length=50), nullable=False, server_default=sa.text("'sea'")),
            sa.Column('created_date', sa.Date(), nullable=True),
            sa.Column('etd_date', sa.Date(), nullable=True),
            sa.Column('eta_date', sa.Date(), nullable=True),
            sa.Column('expected_inbound_start_date', sa.Date(), nullable=True),
            sa.Column('expected_inbound_end_date', sa.Date(), nullable=True),
            sa.Column('booking_note', sa.Text(), nullable=True),
            sa.Column('forwarder_update', sa.Text(), nullable=True),
            sa.Column('remark', sa.Text(), nullable=True),
            sa.Column('shipment_status', sa.String(length=30), nullable=False, server_default=sa.text("'draft'")),
            sa.Column('stat_date', sa.Date(), nullable=True),
            sa.Column('source_type', sa.String(length=20), nullable=False, server_default=sa.text("'manual'")),
            sa.Column('source_file', sa.String(length=255), nullable=True),
            sa.Column('created_by', sa.String(length=255), nullable=True),
            sa.Column('updated_by', sa.String(length=255), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('CURRENT_TIMESTAMP')),
            sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('CURRENT_TIMESTAMP')),
            sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
            sa.UniqueConstraint('shipment_no', name='shipment_schedules_shipment_no_key'),
            sa.CheckConstraint(
                "shipment_status in ('draft', 'preparing', 'in_transit', 'arrived_port', 'inbound_processing', 'completed', 'cancelled')",
                name='ck_shipment_schedules_status',
            ),
            sa.CheckConstraint(
                "shipping_method in ('sea', 'air', 'express', 'truck', 'rail', 'other')",
                name='ck_shipment_schedules_method',
            ),
        )

    op.execute('create index if not exists idx_shipment_schedules_project_id on shipment_schedules (project_id)')
    op.execute('create index if not exists idx_shipment_schedules_shipment_no on shipment_schedules (shipment_no)')
    op.execute('create index if not exists idx_shipment_schedules_status on shipment_schedules (shipment_status)')
    op.execute('create index if not exists idx_shipment_schedules_project_status on shipment_schedules (project_id, shipment_status)')
    op.execute('create index if not exists idx_shipment_schedules_etd on shipment_schedules (etd_date)')
    op.execute('create index if not exists idx_shipment_schedules_eta on shipment_schedules (eta_date)')

    if not inspector.has_table('shipment_schedule_items'):
        op.create_table(
            'shipment_schedule_items',
            sa.Column('id', BIGINT_SQLITE, primary_key=True, autoincrement=True),
            sa.Column('shipment_schedule_id', BIGINT_SQLITE, nullable=False),
            sa.Column('project_id', BIGINT_SQLITE, nullable=False),
            sa.Column('shipment_no', sa.String(length=100), nullable=False),
            sa.Column('item_date', sa.Date(), nullable=True),
            sa.Column('sku', sa.String(length=100), nullable=False),
            sa.Column('quantity', sa.Integer(), nullable=False),
            sa.Column('remark', sa.Text(), nullable=True),
            sa.Column('source_type', sa.String(length=20), nullable=False, server_default=sa.text("'manual'")),
            sa.Column('source_file', sa.String(length=255), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('CURRENT_TIMESTAMP')),
            sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('CURRENT_TIMESTAMP')),
            sa.ForeignKeyConstraint(['shipment_schedule_id'], ['shipment_schedules.id'], ondelete='CASCADE'),
            sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
            sa.UniqueConstraint('shipment_schedule_id', 'sku', name='shipment_schedule_items_schedule_sku_key'),
            sa.CheckConstraint('quantity > 0', name='ck_shipment_schedule_items_quantity_positive'),
        )

    op.execute('create index if not exists idx_shipment_schedule_items_schedule_id on shipment_schedule_items (shipment_schedule_id)')
    op.execute('create index if not exists idx_shipment_schedule_items_project_id on shipment_schedule_items (project_id)')
    op.execute('create index if not exists idx_shipment_schedule_items_shipment_no on shipment_schedule_items (shipment_no)')


def downgrade() -> None:
    op.execute('drop index if exists idx_shipment_schedule_items_shipment_no')
    op.execute('drop index if exists idx_shipment_schedule_items_project_id')
    op.execute('drop index if exists idx_shipment_schedule_items_schedule_id')
    op.execute('drop table if exists shipment_schedule_items')

    op.execute('drop index if exists idx_shipment_schedules_eta')
    op.execute('drop index if exists idx_shipment_schedules_etd')
    op.execute('drop index if exists idx_shipment_schedules_project_status')
    op.execute('drop index if exists idx_shipment_schedules_status')
    op.execute('drop index if exists idx_shipment_schedules_shipment_no')
    op.execute('drop index if exists idx_shipment_schedules_project_id')
    op.execute('drop table if exists shipment_schedules')
