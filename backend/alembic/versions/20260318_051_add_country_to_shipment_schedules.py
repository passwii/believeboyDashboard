"""add country to shipment schedules and summaries

Revision ID: 20260318_051
Revises: 20260314_050
Create Date: 2026-03-18 16:30:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260318_051'
down_revision: Union[str, None] = '20260314_050'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_column(inspector: sa.Inspector, table_name: str, column_name: str) -> bool:
    return any(column['name'] == column_name for column in inspector.get_columns(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if inspector.has_table('shipment_schedules') and not _has_column(inspector, 'shipment_schedules', 'country'):
        op.add_column(
            'shipment_schedules',
            sa.Column('country', sa.String(length=2), nullable=False, server_default='US'),
        )
        op.execute("update shipment_schedules set country = 'US' where country is null or trim(country) = ''")
        op.create_index(
            'idx_shipment_schedules_project_country',
            'shipment_schedules',
            ['project_id', 'country'],
            unique=False,
        )

    inspector = sa.inspect(bind)
    if inspector.has_table('shipment_sku_summaries'):
        if not _has_column(inspector, 'shipment_sku_summaries', 'country'):
            op.add_column(
                'shipment_sku_summaries',
                sa.Column('country', sa.String(length=2), nullable=False, server_default='US'),
            )
            op.execute("update shipment_sku_summaries set country = 'US' where country is null or trim(country) = ''")

        unique_names = {constraint['name'] for constraint in inspector.get_unique_constraints('shipment_sku_summaries')}
        if 'shipment_sku_summaries_project_sku_key' in unique_names:
            op.drop_constraint(
                'shipment_sku_summaries_project_sku_key',
                'shipment_sku_summaries',
                type_='unique',
            )
        unique_names = {constraint['name'] for constraint in sa.inspect(bind).get_unique_constraints('shipment_sku_summaries')}
        if 'shipment_sku_summaries_project_sku_country_key' not in unique_names:
            op.create_unique_constraint(
                'shipment_sku_summaries_project_sku_country_key',
                'shipment_sku_summaries',
                ['project_id', 'sku', 'country'],
            )

        index_names = {index['name'] for index in sa.inspect(bind).get_indexes('shipment_sku_summaries')}
        if 'idx_shipment_sku_summaries_country' not in index_names:
            op.create_index(
                'idx_shipment_sku_summaries_country',
                'shipment_sku_summaries',
                ['country'],
                unique=False,
            )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if inspector.has_table('shipment_sku_summaries'):
        index_names = {index['name'] for index in inspector.get_indexes('shipment_sku_summaries')}
        if 'idx_shipment_sku_summaries_country' in index_names:
            op.drop_index('idx_shipment_sku_summaries_country', table_name='shipment_sku_summaries')

        unique_names = {constraint['name'] for constraint in inspector.get_unique_constraints('shipment_sku_summaries')}
        if 'shipment_sku_summaries_project_sku_country_key' in unique_names:
            op.drop_constraint(
                'shipment_sku_summaries_project_sku_country_key',
                'shipment_sku_summaries',
                type_='unique',
            )
        unique_names = {constraint['name'] for constraint in sa.inspect(bind).get_unique_constraints('shipment_sku_summaries')}
        if 'shipment_sku_summaries_project_sku_key' not in unique_names:
            op.create_unique_constraint(
                'shipment_sku_summaries_project_sku_key',
                'shipment_sku_summaries',
                ['project_id', 'sku'],
            )

        if _has_column(sa.inspect(bind), 'shipment_sku_summaries', 'country'):
            op.drop_column('shipment_sku_summaries', 'country')

    inspector = sa.inspect(bind)
    if inspector.has_table('shipment_schedules'):
        index_names = {index['name'] for index in inspector.get_indexes('shipment_schedules')}
        if 'idx_shipment_schedules_project_country' in index_names:
            op.drop_index('idx_shipment_schedules_project_country', table_name='shipment_schedules')
        if _has_column(sa.inspect(bind), 'shipment_schedules', 'country'):
            op.drop_column('shipment_schedules', 'country')
