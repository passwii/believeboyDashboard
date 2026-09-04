"""create inventory replenishment settings

Revision ID: 20260308_032
Revises: 20260308_031
Create Date: 2026-03-08 22:45:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260308_032'
down_revision: Union[str, None] = '20260308_031'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

BIGINT_SQLITE = sa.BigInteger().with_variant(sa.Integer(), 'sqlite')


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table('inventory_replenishment_settings'):
        op.create_table(
            'inventory_replenishment_settings',
            sa.Column('id', BIGINT_SQLITE, primary_key=True, autoincrement=True),
            sa.Column('project_id', BIGINT_SQLITE, nullable=False),
            sa.Column('project_name', sa.String(length=255), nullable=False),
            sa.Column('sku', sa.String(length=128), nullable=False),
            sa.Column('asin', sa.String(length=64), nullable=True),
            sa.Column('production_lead_days', sa.Integer(), nullable=False, server_default=sa.text('20')),
            sa.Column('shipping_days', sa.Integer(), nullable=False, server_default=sa.text('25')),
            sa.Column('safety_factor', sa.Numeric(8, 4), nullable=False, server_default=sa.text('0.20')),
            sa.Column('created_by', sa.String(length=255), nullable=True),
            sa.Column('updated_by', sa.String(length=255), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('CURRENT_TIMESTAMP')),
            sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('CURRENT_TIMESTAMP')),
            sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
            sa.UniqueConstraint('project_id', 'sku', name='uq_inventory_replenishment_settings_project_sku'),
            sa.CheckConstraint('production_lead_days >= 0', name='ck_inventory_replenishment_settings_production_lead_days'),
            sa.CheckConstraint('shipping_days >= 0', name='ck_inventory_replenishment_settings_shipping_days'),
            sa.CheckConstraint('safety_factor >= 0', name='ck_inventory_replenishment_settings_safety_factor'),
        )

    op.execute(
        'create index if not exists idx_inventory_replenishment_settings_project_id '
        'on inventory_replenishment_settings (project_id)'
    )
    op.execute(
        'create index if not exists idx_inventory_replenishment_settings_project_sku '
        'on inventory_replenishment_settings (project_id, sku)'
    )


def downgrade() -> None:
    op.execute('drop index if exists idx_inventory_replenishment_settings_project_sku')
    op.execute('drop index if exists idx_inventory_replenishment_settings_project_id')
    op.execute('drop table if exists inventory_replenishment_settings')
