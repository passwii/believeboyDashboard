"""add sort_order to product_costs

Revision ID: 20260303_022
Revises: 20260303_021
Create Date: 2026-03-03 15:35:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260303_022'
down_revision: Union[str, None] = '20260303_021'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(inspector: sa.Inspector, table_name: str) -> bool:
    return table_name in inspector.get_table_names()


def _has_column(inspector: sa.Inspector, table_name: str, column_name: str) -> bool:
    return any(col['name'] == column_name for col in inspector.get_columns(table_name))


def _has_index(inspector: sa.Inspector, table_name: str, index_name: str) -> bool:
    return any(idx.get('name') == index_name for idx in inspector.get_indexes(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if _has_table(inspector, 'product_costs') is False:
        return

    if _has_column(inspector, 'product_costs', 'sort_order') is False:
        op.add_column(
            'product_costs',
            sa.Column('sort_order', sa.Integer(), nullable=False, server_default=sa.text('1')),
        )

    dialect = bind.dialect.name
    if dialect == 'sqlite':
        rows = bind.execute(sa.text('select id, project_name from product_costs order by project_name asc, id asc')).fetchall()
        counter: dict[str, int] = {}
        for row in rows:
            project_name = str(row.project_name)
            next_sort = counter.get(project_name, 0) + 1
            counter[project_name] = next_sort
            bind.execute(
                sa.text('update product_costs set sort_order = :sort_order where id = :id'),
                {'sort_order': next_sort, 'id': int(row.id)},
            )
    else:
        bind.execute(
            sa.text(
                """
                with ranked as (
                    select
                        id,
                        row_number() over (
                            partition by project_name
                            order by id asc
                        ) as rn
                    from product_costs
                )
                update product_costs as pc
                set sort_order = ranked.rn
                from ranked
                where pc.id = ranked.id
                """
            )
        )

    inspector = sa.inspect(bind)
    if _has_index(inspector, 'product_costs', 'idx_product_costs_sort_order') is False:
        op.create_index('idx_product_costs_sort_order', 'product_costs', ['sort_order'], unique=False)

    inspector = sa.inspect(bind)
    if _has_index(inspector, 'product_costs', 'idx_product_costs_project_sort') is False:
        op.create_index('idx_product_costs_project_sort', 'product_costs', ['project_name', 'sort_order', 'id'], unique=False)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if _has_table(inspector, 'product_costs') is False:
        return

    if _has_index(inspector, 'product_costs', 'idx_product_costs_project_sort'):
        op.drop_index('idx_product_costs_project_sort', table_name='product_costs')

    inspector = sa.inspect(bind)
    if _has_index(inspector, 'product_costs', 'idx_product_costs_sort_order'):
        op.drop_index('idx_product_costs_sort_order', table_name='product_costs')

    inspector = sa.inspect(bind)
    if _has_column(inspector, 'product_costs', 'sort_order'):
        op.drop_column('product_costs', 'sort_order')
