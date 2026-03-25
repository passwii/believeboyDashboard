"""fix projects id sequence drift

Revision ID: 20260325_069
Revises: 20260324_068
Create Date: 2026-03-25 10:30:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260325_069"
down_revision: Union[str, None] = "20260324_068"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return

    op.execute(
        sa.text(
            """
            with target_sequences as (
              select distinct s.relname as sequence_name
              from pg_class c
              join pg_attribute a
                on a.attrelid = c.oid
               and a.attname = 'id'
              join pg_depend d
                on d.refobjid = c.oid
               and d.refobjsubid = a.attnum
               and d.deptype in ('a', 'i')
              join pg_class s
                on s.oid = d.objid
               and s.relkind = 'S'
              where c.oid = 'public.projects'::regclass
            )
            select setval(
              format('public.%I', sequence_name),
              coalesce((select max(id) from public.projects), 1),
              coalesce((select max(id) is not null from public.projects), false)
            )
            from target_sequences
            """
        )
    )


def downgrade() -> None:
    pass
