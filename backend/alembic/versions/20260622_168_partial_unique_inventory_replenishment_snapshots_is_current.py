"""partial unique index on inventory_replenishment_snapshots.is_current

Revision ID: 20260622_168
Revises: 20260622_167
Create Date: 2026-06-22 12:00:00.000000

Replaces the legacy ``uq_inventory_replenishment_snapshot_project_country_date``
(unique on ``(project_id, country, snapshot_date)``) with a partial unique index on
``(project_id, country) WHERE is_current = TRUE``.

Background
----------
The original schema forced at most one snapshot per ``(project, country, date)``,
which made it impossible to re-save a snapshot for the same day: the second
``INSERT`` raised ``UniqueViolation`` (see backend logs from 2026-06-22 10:38:02
on /inventory-replenishment). The product intent is "one current snapshot per
``(project, country)``", enforced via the ``is_current`` column.

Steps
-----
1. Dedupe any pre-existing ``is_current = TRUE`` rows so that the partial unique
   index can be created. For each ``(project_id, country)`` group, keep only the
   most-recently-created ``is_current = TRUE`` row and flip the rest to FALSE.
2. Drop the old unique constraint.
3. Create the partial unique index (PG and SQLite branch, mirroring
   ``20260227_009_monthly_report_versioning.py``).
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '20260622_168'
down_revision: Union[str, None] = '20260622_167'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_unique_constraint(inspector, table_name: str, constraint_name: str) -> bool:
    constraints = inspector.get_unique_constraints(table_name)
    return any(item.get('name') == constraint_name for item in constraints)


def _has_index(inspector, table_name: str, index_name: str) -> bool:
    indexes = inspector.get_indexes(table_name)
    return any(item.get('name') == index_name for item in indexes)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    dialect = bind.dialect.name

    if not inspector.has_table('inventory_replenishment_snapshots'):
        return

    # 1) Dedupe: keep only the latest is_current=TRUE row per (project_id, country).
    #    Older is_current=TRUE rows for the same group are flipped to FALSE so
    #    the partial unique index can be created without violating itself.
    if dialect == 'sqlite':
        op.execute(
            """
            update inventory_replenishment_snapshots
            set is_current = 0
            where id not in (
                select id from (
                    select
                        id,
                        row_number() over (
                            partition by project_id, country
                            order by created_at desc, id desc
                        ) as rn
                    from inventory_replenishment_snapshots
                    where is_current = 1
                ) dedupe
                where rn = 1
            )
            and is_current = 1
            """
        )
    else:
        op.execute(
            """
            update inventory_replenishment_snapshots
            set is_current = false
            where id not in (
                select id from (
                    select
                        id,
                        row_number() over (
                            partition by project_id, country
                            order by created_at desc, id desc
                        ) as rn
                    from inventory_replenishment_snapshots
                    where is_current is true
                ) dedupe
                where rn = 1
            )
            and is_current is true
            """
        )

    # 2) Drop the legacy unique constraint (if it still exists).
    inspector = sa.inspect(bind)
    if _has_unique_constraint(
        inspector,
        'inventory_replenishment_snapshots',
        'uq_inventory_replenishment_snapshot_project_country_date',
    ):
        with op.batch_alter_table('inventory_replenishment_snapshots') as batch_op:
            batch_op.drop_constraint(
                'uq_inventory_replenishment_snapshot_project_country_date',
                type_='unique',
            )

    # 3) Create the partial unique index enforcing "at most one current snapshot
    #    per (project, country)". Branch on dialect for the WHERE clause syntax.
    inspector = sa.inspect(bind)
    if not _has_index(
        inspector,
        'inventory_replenishment_snapshots',
        'uq_inventory_replenishment_snapshots_current',
    ):
        if dialect == 'sqlite':
            op.execute(
                'create unique index uq_inventory_replenishment_snapshots_current '
                'on inventory_replenishment_snapshots (project_id, country) '
                'where is_current = 1'
            )
        else:
            op.execute(
                'create unique index uq_inventory_replenishment_snapshots_current '
                'on inventory_replenishment_snapshots (project_id, country) '
                'where is_current is true'
            )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    dialect = bind.dialect.name

    if not inspector.has_table('inventory_replenishment_snapshots'):
        return

    # Drop the partial unique index first.
    op.execute('drop index if exists uq_inventory_replenishment_snapshots_current')

    # Re-create the original unique constraint if missing.
    inspector = sa.inspect(bind)
    if not _has_unique_constraint(
        inspector,
        'inventory_replenishment_snapshots',
        'uq_inventory_replenishment_snapshot_project_country_date',
    ):
        with op.batch_alter_table('inventory_replenishment_snapshots') as batch_op:
            batch_op.create_unique_constraint(
                'uq_inventory_replenishment_snapshot_project_country_date',
                ['project_id', 'country', 'snapshot_date'],
            )

    # No-op: any duplicate is_current rows that were deduped by upgrade() stay
    # in their is_current=FALSE state, which is what the original constraint
    # expected (the original schema only constrained (project, country, date)).
