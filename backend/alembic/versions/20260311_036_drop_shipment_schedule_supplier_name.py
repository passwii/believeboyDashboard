"""drop shipment schedule supplier name

Revision ID: 20260311_036
Revises: 20260311_035
Create Date: 2026-03-11 15:20:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260311_036'
down_revision: Union[str, None] = '20260311_035'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {column['name'] for column in inspector.get_columns('shipment_schedules')}
    if 'supplier_name' not in columns:
        return

    with op.batch_alter_table('shipment_schedules') as batch_op:
        batch_op.drop_column('supplier_name')


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {column['name'] for column in inspector.get_columns('shipment_schedules')}
    if 'supplier_name' in columns:
        return

    with op.batch_alter_table('shipment_schedules') as batch_op:
        batch_op.add_column(sa.Column('supplier_name', sa.String(length=100), nullable=True))
