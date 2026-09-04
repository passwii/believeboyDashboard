"""rename analysis ad rows table

Revision ID: 20260318_056
Revises: 20260318_055
Create Date: 2026-03-18 21:25:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260318_056'
down_revision: Union[str, None] = '20260318_055'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


OLD_TABLE = 'analysis_ad_rows'
NEW_TABLE = 'analysis_ad_product_rows'


def _rename_postgres_objects() -> None:
    op.execute(f'alter table {OLD_TABLE} rename to {NEW_TABLE}')
    op.execute(
        'alter table analysis_ad_product_rows rename constraint analysis_ad_rows_source_row_key '
        'to analysis_ad_product_rows_source_row_key'
    )
    op.execute(
        'alter table analysis_ad_product_rows rename constraint ck_analysis_ad_scope_status '
        'to ck_analysis_ad_product_scope_status'
    )
    op.execute('alter index idx_analysis_ad_source_id rename to idx_analysis_ad_product_source_id')
    op.execute('alter index idx_analysis_ad_source_sku rename to idx_analysis_ad_product_source_sku')
    op.execute('alter index idx_analysis_ad_scope rename to idx_analysis_ad_product_scope')


def _rename_postgres_objects_back() -> None:
    op.execute('alter index idx_analysis_ad_product_scope rename to idx_analysis_ad_scope')
    op.execute('alter index idx_analysis_ad_product_source_sku rename to idx_analysis_ad_source_sku')
    op.execute('alter index idx_analysis_ad_product_source_id rename to idx_analysis_ad_source_id')
    op.execute(
        'alter table analysis_ad_product_rows rename constraint ck_analysis_ad_product_scope_status '
        'to ck_analysis_ad_scope_status'
    )
    op.execute(
        'alter table analysis_ad_product_rows rename constraint analysis_ad_product_rows_source_row_key '
        'to analysis_ad_rows_source_row_key'
    )
    op.execute(f'alter table {NEW_TABLE} rename to {OLD_TABLE}')


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())
    if NEW_TABLE in tables:
        return
    if OLD_TABLE not in tables:
        return
    if bind.dialect.name == 'postgresql':
        _rename_postgres_objects()
        return

    with op.batch_alter_table(OLD_TABLE, recreate='always', table_kwargs={'sqlite_autoincrement': True}) as batch_op:
        batch_op.drop_constraint('analysis_ad_rows_source_row_key', type_='unique')
        batch_op.drop_constraint('ck_analysis_ad_scope_status', type_='check')
        batch_op.create_unique_constraint('analysis_ad_product_rows_source_row_key', ['source_file_id', 'source_row_no'])
        batch_op.create_check_constraint(
            'ck_analysis_ad_product_scope_status',
            "scope_status in ('included_product', 'excluded_store_level', 'excluded_unmapped')",
        )
    op.execute(f'alter table {OLD_TABLE} rename to {NEW_TABLE}')
    op.execute(f'create index if not exists idx_analysis_ad_product_source_id on {NEW_TABLE} (source_file_id)')
    op.execute(f'create index if not exists idx_analysis_ad_product_source_sku on {NEW_TABLE} (source_file_id, sku)')
    op.execute(f'create index if not exists idx_analysis_ad_product_scope on {NEW_TABLE} (source_file_id, scope_status)')


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())
    if OLD_TABLE in tables:
        return
    if NEW_TABLE not in tables:
        return
    if bind.dialect.name == 'postgresql':
        _rename_postgres_objects_back()
        return

    with op.batch_alter_table(NEW_TABLE, recreate='always', table_kwargs={'sqlite_autoincrement': True}) as batch_op:
        batch_op.drop_constraint('analysis_ad_product_rows_source_row_key', type_='unique')
        batch_op.drop_constraint('ck_analysis_ad_product_scope_status', type_='check')
        batch_op.create_unique_constraint('analysis_ad_rows_source_row_key', ['source_file_id', 'source_row_no'])
        batch_op.create_check_constraint(
            'ck_analysis_ad_scope_status',
            "scope_status in ('included_product', 'excluded_store_level', 'excluded_unmapped')",
        )
    op.execute(f'alter table {NEW_TABLE} rename to {OLD_TABLE}')
    op.execute(f'create index if not exists idx_analysis_ad_source_id on {OLD_TABLE} (source_file_id)')
    op.execute(f'create index if not exists idx_analysis_ad_source_sku on {OLD_TABLE} (source_file_id, sku)')
    op.execute(f'create index if not exists idx_analysis_ad_scope on {OLD_TABLE} (source_file_id, scope_status)')
