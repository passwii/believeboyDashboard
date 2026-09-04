"""update shipment schedule fields

Revision ID: 20260311_037
Revises: 20260311_036
Create Date: 2026-03-11 18:20:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260311_037'
down_revision: Union[str, None] = '20260311_036'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {column['name'] for column in inspector.get_columns('shipment_schedules')}

    with op.batch_alter_table('shipment_schedules') as batch_op:
        if 'actual_inbound_date' not in columns:
            batch_op.add_column(sa.Column('actual_inbound_date', sa.Date(), nullable=True))
        if 'expected_inbound_start_date' in columns:
            batch_op.drop_column('expected_inbound_start_date')
        if 'expected_inbound_end_date' in columns:
            batch_op.drop_column('expected_inbound_end_date')
        if 'booking_note' in columns:
            batch_op.drop_column('booking_note')
        if 'forwarder_update' in columns:
            batch_op.drop_column('forwarder_update')
        if 'stat_date' in columns:
            batch_op.drop_column('stat_date')


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {column['name'] for column in inspector.get_columns('shipment_schedules')}

    with op.batch_alter_table('shipment_schedules') as batch_op:
        if 'stat_date' not in columns:
            batch_op.add_column(sa.Column('stat_date', sa.Date(), nullable=True))
        if 'forwarder_update' not in columns:
            batch_op.add_column(sa.Column('forwarder_update', sa.Text(), nullable=True))
        if 'booking_note' not in columns:
            batch_op.add_column(sa.Column('booking_note', sa.Text(), nullable=True))
        if 'expected_inbound_end_date' not in columns:
            batch_op.add_column(sa.Column('expected_inbound_end_date', sa.Date(), nullable=True))
        if 'expected_inbound_start_date' not in columns:
            batch_op.add_column(sa.Column('expected_inbound_start_date', sa.Date(), nullable=True))
        if 'actual_inbound_date' in columns:
            batch_op.drop_column('actual_inbound_date')
