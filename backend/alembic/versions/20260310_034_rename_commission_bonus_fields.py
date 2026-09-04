"""rename commission record bonus fields

Revision ID: 20260310_034
Revises: 20260309_033
Create Date: 2026-03-10 18:30:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260310_034'
down_revision: Union[str, None] = '20260309_033'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(inspector: sa.Inspector, table_name: str) -> bool:
    return table_name in inspector.get_table_names()


def _has_column(inspector: sa.Inspector, table_name: str, column_name: str) -> bool:
    return any(col['name'] == column_name for col in inspector.get_columns(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if _has_table(inspector, 'commission_records') is False:
        return
    if bind.dialect.name == 'sqlite' and not inspector.has_table('projects'):
        return

    with op.batch_alter_table('commission_records') as batch_op:
        if _has_column(inspector, 'commission_records', 'public_commission_ratio'):
            batch_op.alter_column('public_commission_ratio', new_column_name='operator_bonus_ratio')
        if _has_column(inspector, 'commission_records', 'commission_amount_usd'):
            batch_op.alter_column('commission_amount_usd', new_column_name='bonus_amount_usd')
        if _has_column(inspector, 'commission_records', 'commission_amount_rmb'):
            batch_op.alter_column('commission_amount_rmb', new_column_name='bonus_amount_rmb')
        if _has_column(inspector, 'commission_records', 'ratio_source'):
            batch_op.alter_column('ratio_source', new_column_name='bonus_ratio_source')
        if _has_column(inspector, 'commission_records', 'manual_ratio'):
            batch_op.alter_column('manual_ratio', new_column_name='manual_bonus_ratio')

    dialect = bind.dialect.name
    if dialect == 'postgresql':
        op.execute("alter table commission_records drop constraint if exists ck_commission_records_public_ratio")
        op.execute("alter table commission_records drop constraint if exists ck_commission_records_ratio_source")
        op.execute("alter table commission_records drop constraint if exists ck_commission_records_manual_ratio")
        op.execute(
            "alter table commission_records add constraint ck_commission_records_operator_bonus_ratio "
            "check (operator_bonus_ratio >= 0 and operator_bonus_ratio <= 1)"
        )
        op.execute(
            "alter table commission_records add constraint ck_commission_records_bonus_ratio_source "
            "check (bonus_ratio_source in ('rule', 'manual'))"
        )
        op.execute(
            "alter table commission_records add constraint ck_commission_records_manual_bonus_ratio "
            "check (manual_bonus_ratio is null or (manual_bonus_ratio >= 0 and manual_bonus_ratio <= 1))"
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if _has_table(inspector, 'commission_records') is False:
        return
    if bind.dialect.name == 'sqlite' and not inspector.has_table('projects'):
        return

    dialect = bind.dialect.name
    if dialect == 'postgresql':
        op.execute("alter table commission_records drop constraint if exists ck_commission_records_manual_bonus_ratio")
        op.execute("alter table commission_records drop constraint if exists ck_commission_records_bonus_ratio_source")
        op.execute("alter table commission_records drop constraint if exists ck_commission_records_operator_bonus_ratio")

    with op.batch_alter_table('commission_records') as batch_op:
        inspector = sa.inspect(bind)
        if _has_column(inspector, 'commission_records', 'manual_bonus_ratio'):
            batch_op.alter_column('manual_bonus_ratio', new_column_name='manual_ratio')
        if _has_column(inspector, 'commission_records', 'bonus_ratio_source'):
            batch_op.alter_column('bonus_ratio_source', new_column_name='ratio_source')
        if _has_column(inspector, 'commission_records', 'bonus_amount_rmb'):
            batch_op.alter_column('bonus_amount_rmb', new_column_name='commission_amount_rmb')
        if _has_column(inspector, 'commission_records', 'bonus_amount_usd'):
            batch_op.alter_column('bonus_amount_usd', new_column_name='commission_amount_usd')
        if _has_column(inspector, 'commission_records', 'operator_bonus_ratio'):
            batch_op.alter_column('operator_bonus_ratio', new_column_name='public_commission_ratio')

    if dialect == 'postgresql':
        op.execute(
            "alter table commission_records add constraint ck_commission_records_public_ratio "
            "check (public_commission_ratio >= 0 and public_commission_ratio <= 1)"
        )
        op.execute(
            "alter table commission_records add constraint ck_commission_records_ratio_source "
            "check (ratio_source in ('rule', 'manual'))"
        )
        op.execute(
            "alter table commission_records add constraint ck_commission_records_manual_ratio "
            "check (manual_ratio is null or (manual_ratio >= 0 and manual_ratio <= 1))"
        )
