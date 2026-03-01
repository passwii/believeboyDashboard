"""monthly report report_month use YYYY-MM text

Revision ID: 20260227_008
Revises: 20260227_007
Create Date: 2026-02-27 01:20:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260227_008'
down_revision: Union[str, None] = '20260227_007'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLE_CHECKS = {
    'monthly_reports': 'ck_monthly_reports_report_month_format',
    'monthly_report_transactions': 'ck_monthly_transactions_report_month_format',
    'monthly_report_pt3_calculation': 'ck_monthly_pt3_report_month_format',
    'monthly_report_pt4_calculation': 'ck_monthly_pt4_report_month_format',
}


def _has_check_constraint(inspector, table_name: str, check_name: str) -> bool:
    checks = inspector.get_check_constraints(table_name)
    return any(check.get('name') == check_name for check in checks)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    dialect = bind.dialect.name

    for table_name, check_name in _TABLE_CHECKS.items():
        if not inspector.has_table(table_name):
            continue

        columns = {column['name'] for column in inspector.get_columns(table_name)}
        if 'report_month' not in columns:
            continue

        if dialect != 'postgresql':
            op.execute(
                sa.text(
                    f"""
                    update {table_name}
                    set report_month = substr(cast(report_month as text), 1, 7)
                    where report_month is not null
                    """
                )
            )

        if dialect == 'postgresql':
            with op.batch_alter_table(table_name) as batch_op:
                batch_op.alter_column(
                    'report_month',
                    existing_type=sa.Date(),
                    type_=sa.String(length=7),
                    existing_nullable=False,
                    postgresql_using="to_char(report_month, 'YYYY-MM')",
                )
        else:
            with op.batch_alter_table(table_name) as batch_op:
                batch_op.alter_column(
                    'report_month',
                    existing_type=sa.Date(),
                    type_=sa.String(length=7),
                    existing_nullable=False,
                )

        inspector = sa.inspect(bind)
        if not _has_check_constraint(inspector, table_name, check_name):
            with op.batch_alter_table(table_name) as batch_op:
                batch_op.create_check_constraint(check_name, "report_month LIKE '____-__'")


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    dialect = bind.dialect.name

    for table_name, check_name in _TABLE_CHECKS.items():
        if not inspector.has_table(table_name):
            continue

        columns = {column['name'] for column in inspector.get_columns(table_name)}
        if 'report_month' not in columns:
            continue

        if _has_check_constraint(inspector, table_name, check_name):
            with op.batch_alter_table(table_name) as batch_op:
                batch_op.drop_constraint(check_name, type_='check')

        if dialect == 'postgresql':
            with op.batch_alter_table(table_name) as batch_op:
                batch_op.alter_column(
                    'report_month',
                    existing_type=sa.String(length=7),
                    type_=sa.Date(),
                    existing_nullable=False,
                    postgresql_using="to_date(report_month || '-01', 'YYYY-MM-DD')",
                )
        else:
            op.execute(
                sa.text(
                    f"""
                    update {table_name}
                    set report_month = report_month || '-01'
                    where report_month is not null and length(report_month) = 7
                    """
                )
            )
            with op.batch_alter_table(table_name) as batch_op:
                batch_op.alter_column(
                    'report_month',
                    existing_type=sa.String(length=7),
                    type_=sa.Date(),
                    existing_nullable=False,
                )

        inspector = sa.inspect(bind)
