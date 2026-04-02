"""add carton_count to shipment_schedule_items and backfill

Revision ID: 20260331_079
Revises: 20260330_078
Create Date: 2026-03-31 12:00:00
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260331_079'
down_revision: Union[str, None] = '20260330_078'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    columns = (
        inspector.get_columns('shipment_schedule_items')
        if inspector.has_table('shipment_schedule_items')
        else []
    )
    column_names = {c['name'] for c in columns}

    # Step 1: add column (nullable first so we can backfill)
    if 'carton_count' not in column_names:
        op.add_column(
            'shipment_schedule_items',
            sa.Column(
                'carton_count',
                sa.Integer(),
                nullable=True,
                server_default=sa.text('NULL'),
            ),
        )

    # Step 2: backfill — quantity / units_per_carton for rows that have a valid units_per_carton
    # JOIN path: shipment_schedule_items → shipment_schedules → projects → product_costs
    backfill_sql = sa.text("""
        UPDATE shipment_schedule_items AS si
        SET carton_count = q.new_carton_count
        FROM (
            SELECT
                si_inner.id        AS item_id,
                CASE
                    WHEN pc.units_per_carton > 0
                    THEN si_inner.quantity / pc.units_per_carton
                    ELSE NULL
                END                 AS new_carton_count
            FROM shipment_schedule_items si_inner
            JOIN shipment_schedules ss
              ON ss.id = si_inner.shipment_schedule_id
            JOIN projects p
              ON p.id = ss.project_id
            LEFT JOIN product_costs pc
                   ON pc.project_name = p.project_name
                  AND pc.sku = si_inner.sku
                  AND pc.country = ss.country
            WHERE
                (si_inner.carton_count IS NULL OR si_inner.carton_count = 0)
                AND pc.units_per_carton > 0
        ) AS q
        WHERE si.id = q.item_id
    """)
    bind.execute(backfill_sql)

    # Step 3: add NOT NULL check (rows with NULL may still exist for SKUs without units_per_carton)
    # Only add the check if all existing non-null rows satisfy it
    op.create_check_constraint(
        'ck_shipment_schedule_items_carton_count_non_negative',
        'shipment_schedule_items',
        'carton_count IS NULL OR carton_count >= 0',
    )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = (
        inspector.get_columns('shipment_schedule_items')
        if inspector.has_table('shipment_schedule_items')
        else []
    )
    column_names = {c['name'] for c in columns}

    if 'carton_count' in column_names:
        op.drop_constraint(
            'ck_shipment_schedule_items_carton_count_non_negative',
            'shipment_schedule_items',
            type_='check',
        )
        op.drop_column('shipment_schedule_items', 'carton_count')
