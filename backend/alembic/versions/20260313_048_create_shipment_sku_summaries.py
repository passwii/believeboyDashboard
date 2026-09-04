"""create shipment sku summaries

Revision ID: 20260313_048
Revises: 20260313_047
Create Date: 2026-03-14 00:40:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = '20260313_048'
down_revision = '20260313_047'
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table('shipment_sku_summaries'):
        return

    op.create_table(
        'shipment_sku_summaries',
        sa.Column('id', sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column('project_id', sa.BigInteger(), sa.ForeignKey('projects.id', ondelete='CASCADE'), nullable=False),
        sa.Column('project_name_snapshot', sa.String(length=255), nullable=False),
        sa.Column('sku', sa.String(length=100), nullable=False),
        sa.Column('shipment_count', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('total_quantity', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('total_chargeable_weight_kg', sa.Numeric(14, 3), nullable=False, server_default='0'),
        sa.Column('total_logistics_cost', sa.Numeric(14, 2), nullable=False, server_default='0'),
        sa.Column('average_logistics_unit_price', sa.Numeric(14, 4), nullable=False, server_default='0'),
        sa.Column('refreshed_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint('project_id', 'sku', name='shipment_sku_summaries_project_sku_key'),
    )
    op.create_index('idx_shipment_sku_summaries_project_id', 'shipment_sku_summaries', ['project_id'], unique=False)
    op.create_index('ix_shipment_sku_summaries_sku', 'shipment_sku_summaries', ['sku'], unique=False)
    op.create_index('idx_shipment_sku_summaries_project_name', 'shipment_sku_summaries', ['project_name_snapshot'], unique=False)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table('shipment_sku_summaries'):
        return
    op.drop_index('idx_shipment_sku_summaries_project_name', table_name='shipment_sku_summaries')
    op.drop_index('ix_shipment_sku_summaries_sku', table_name='shipment_sku_summaries')
    op.drop_index('idx_shipment_sku_summaries_project_id', table_name='shipment_sku_summaries')
    op.drop_table('shipment_sku_summaries')
