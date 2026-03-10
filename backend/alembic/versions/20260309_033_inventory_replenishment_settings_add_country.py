"""inventory replenishment settings add country

Revision ID: 20260309_033
Revises: 20260308_032
Create Date: 2026-03-09 12:10:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260309_033'
down_revision: Union[str, None] = '20260308_032'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {column['name'] for column in inspector.get_columns('inventory_replenishment_settings')}

    if 'country' not in columns:
        with op.batch_alter_table('inventory_replenishment_settings') as batch_op:
            batch_op.add_column(sa.Column('country', sa.String(length=2), nullable=False, server_default='US'))

    op.execute("update inventory_replenishment_settings set country = 'US' where country is null or trim(country) = ''")

    with op.batch_alter_table('inventory_replenishment_settings') as batch_op:
        batch_op.drop_index('idx_inventory_replenishment_settings_project_sku')
        batch_op.drop_constraint('uq_inventory_replenishment_settings_project_sku', type_='unique')
        batch_op.create_index(
            'idx_inventory_replenishment_settings_project_sku_country',
            ['project_id', 'sku', 'country'],
            unique=False,
        )
        batch_op.create_unique_constraint(
            'uq_inventory_replenishment_settings_project_sku_country',
            ['project_id', 'sku', 'country'],
        )


def downgrade() -> None:
    with op.batch_alter_table('inventory_replenishment_settings') as batch_op:
        batch_op.drop_index('idx_inventory_replenishment_settings_project_sku_country')
        batch_op.drop_constraint('uq_inventory_replenishment_settings_project_sku_country', type_='unique')
        batch_op.create_index('idx_inventory_replenishment_settings_project_sku', ['project_id', 'sku'], unique=False)
        batch_op.create_unique_constraint('uq_inventory_replenishment_settings_project_sku', ['project_id', 'sku'])
        batch_op.drop_column('country')
