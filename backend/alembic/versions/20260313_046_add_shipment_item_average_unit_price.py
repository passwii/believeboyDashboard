"""add shipment item average unit price

Revision ID: 20260313_046
Revises: 20260313_045
Create Date: 2026-03-13 23:55:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = '20260313_046'
down_revision = '20260313_045'
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    item_columns = {column['name'] for column in inspector.get_columns('shipment_schedule_items')}
    with op.batch_alter_table('shipment_schedule_items') as batch_op:
        if 'average_logistics_unit_price' not in item_columns:
            batch_op.add_column(
                sa.Column('average_logistics_unit_price', sa.Numeric(14, 4), nullable=False, server_default='0')
            )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    item_columns = {column['name'] for column in inspector.get_columns('shipment_schedule_items')}
    with op.batch_alter_table('shipment_schedule_items') as batch_op:
        if 'average_logistics_unit_price' in item_columns:
            batch_op.drop_column('average_logistics_unit_price')
