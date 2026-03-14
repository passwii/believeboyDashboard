"""add shipment cost fields

Revision ID: 20260313_045
Revises: 20260313_044
Create Date: 2026-03-13 23:30:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = '20260313_045'
down_revision = '20260313_044'
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    schedule_columns = {column['name'] for column in inspector.get_columns('shipment_schedules')}
    with op.batch_alter_table('shipment_schedules') as batch_op:
        if 'logistics_unit_price' not in schedule_columns:
            batch_op.add_column(sa.Column('logistics_unit_price', sa.Numeric(12, 2), nullable=False, server_default='0'))
        if 'total_volume_m3' not in schedule_columns:
            batch_op.add_column(sa.Column('total_volume_m3', sa.Numeric(14, 4), nullable=False, server_default='0'))
        if 'total_chargeable_weight_kg' not in schedule_columns:
            batch_op.add_column(sa.Column('total_chargeable_weight_kg', sa.Numeric(14, 3), nullable=False, server_default='0'))
        if 'logistics_total_price' not in schedule_columns:
            batch_op.add_column(sa.Column('logistics_total_price', sa.Numeric(14, 2), nullable=False, server_default='0'))

    item_columns = {column['name'] for column in inspector.get_columns('shipment_schedule_items')}
    with op.batch_alter_table('shipment_schedule_items') as batch_op:
        if 'volume_m3' not in item_columns:
            batch_op.add_column(sa.Column('volume_m3', sa.Numeric(14, 4), nullable=False, server_default='0'))
        if 'actual_weight_kg' not in item_columns:
            batch_op.add_column(sa.Column('actual_weight_kg', sa.Numeric(14, 3), nullable=False, server_default='0'))
        if 'volumetric_weight_kg' not in item_columns:
            batch_op.add_column(sa.Column('volumetric_weight_kg', sa.Numeric(14, 3), nullable=False, server_default='0'))
        if 'chargeable_weight_kg' not in item_columns:
            batch_op.add_column(sa.Column('chargeable_weight_kg', sa.Numeric(14, 3), nullable=False, server_default='0'))
        if 'estimated_logistics_cost' not in item_columns:
            batch_op.add_column(sa.Column('estimated_logistics_cost', sa.Numeric(14, 2), nullable=False, server_default='0'))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    schedule_columns = {column['name'] for column in inspector.get_columns('shipment_schedules')}
    with op.batch_alter_table('shipment_schedules') as batch_op:
        if 'logistics_total_price' in schedule_columns:
            batch_op.drop_column('logistics_total_price')
        if 'total_chargeable_weight_kg' in schedule_columns:
            batch_op.drop_column('total_chargeable_weight_kg')
        if 'total_volume_m3' in schedule_columns:
            batch_op.drop_column('total_volume_m3')
        if 'logistics_unit_price' in schedule_columns:
            batch_op.drop_column('logistics_unit_price')

    item_columns = {column['name'] for column in inspector.get_columns('shipment_schedule_items')}
    with op.batch_alter_table('shipment_schedule_items') as batch_op:
        if 'estimated_logistics_cost' in item_columns:
            batch_op.drop_column('estimated_logistics_cost')
        if 'chargeable_weight_kg' in item_columns:
            batch_op.drop_column('chargeable_weight_kg')
        if 'volumetric_weight_kg' in item_columns:
            batch_op.drop_column('volumetric_weight_kg')
        if 'actual_weight_kg' in item_columns:
            batch_op.drop_column('actual_weight_kg')
        if 'volume_m3' in item_columns:
            batch_op.drop_column('volume_m3')
