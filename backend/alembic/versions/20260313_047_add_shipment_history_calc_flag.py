"""add shipment history calc flag

Revision ID: 20260313_047
Revises: 20260313_046
Create Date: 2026-03-14 00:20:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = '20260313_047'
down_revision = '20260313_046'
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {column['name'] for column in inspector.get_columns('shipment_schedules')}
    indexes = {index['name'] for index in inspector.get_indexes('shipment_schedules')}

    if 'include_in_history_shipping_calc' not in columns:
        op.add_column(
            'shipment_schedules',
            sa.Column('include_in_history_shipping_calc', sa.Boolean(), nullable=False, server_default=sa.text('true')),
        )
    if 'idx_shipment_schedules_include_history_calc' not in indexes:
        op.create_index(
            'idx_shipment_schedules_include_history_calc',
            'shipment_schedules',
            ['include_in_history_shipping_calc'],
            unique=False,
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {column['name'] for column in inspector.get_columns('shipment_schedules')}
    indexes = {index['name'] for index in inspector.get_indexes('shipment_schedules')}

    if 'idx_shipment_schedules_include_history_calc' in indexes:
        op.drop_index('idx_shipment_schedules_include_history_calc', table_name='shipment_schedules')
    if 'include_in_history_shipping_calc' in columns:
        op.drop_column('shipment_schedules', 'include_in_history_shipping_calc')
