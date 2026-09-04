"""rename ad_report to ad_product_report

Revision ID: 20260318_054
Revises: 20260318_053
Create Date: 2026-03-18 19:10:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260318_054'
down_revision: Union[str, None] = '20260318_053'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _create_analysis_constraints() -> None:
    with op.batch_alter_table('analysis_source_files') as batch_op:
        batch_op.create_check_constraint(
            'ck_analysis_sources_report_type',
            "report_type in ('business_report', 'payment_report', 'ad_product_report', 'sales_report', 'inventory_report')",
        )
        batch_op.create_check_constraint(
            'ck_analysis_sources_period_or_snapshot',
            "("
            "report_type in ('business_report', 'payment_report', 'ad_product_report', 'sales_report') "
            'and period_start_date is not null '
            'and period_end_date is not null '
            'and period_start_date <= period_end_date '
            'and snapshot_at is null'
            ") or ("
            "report_type = 'inventory_report' "
            'and snapshot_at is not null'
            ')',
        )


def _create_daily_constraints() -> None:
    with op.batch_alter_table('daily_source_files') as batch_op:
        batch_op.create_check_constraint(
            'ck_daily_sources_report_type',
            "report_type in ('sales_report', 'ad_product_report')",
        )


def _recreate_analysis_current_index(dialect: str) -> None:
    op.execute('drop index if exists uq_analysis_sources_period_current')
    if dialect == 'sqlite':
        op.execute(
            'create unique index if not exists uq_analysis_sources_period_current '
            'on analysis_source_files (project_id, report_type, country, period_start_date, period_end_date) '
            "where report_type in ('business_report', 'payment_report', 'ad_product_report', 'sales_report') and is_current = 1"
        )
    else:
        op.execute(
            'create unique index if not exists uq_analysis_sources_period_current '
            'on analysis_source_files (project_id, report_type, country, period_start_date, period_end_date) '
            "where report_type in ('business_report', 'payment_report', 'ad_product_report', 'sales_report') and is_current is true"
        )


def _drop_analysis_constraints() -> None:
    with op.batch_alter_table('analysis_source_files') as batch_op:
        batch_op.drop_constraint('ck_analysis_sources_report_type', type_='check')
        batch_op.drop_constraint('ck_analysis_sources_period_or_snapshot', type_='check')


def _drop_daily_constraints() -> None:
    with op.batch_alter_table('daily_source_files') as batch_op:
        batch_op.drop_constraint('ck_daily_sources_report_type', type_='check')


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    dialect = bind.dialect.name

    if inspector.has_table('analysis_source_files'):
        _drop_analysis_constraints()
        op.execute(
            "update analysis_source_files set report_type = 'ad_product_report' where report_type = 'ad_report'"
        )
        _create_analysis_constraints()
        _recreate_analysis_current_index(dialect)

    if inspector.has_table('daily_source_files'):
        _drop_daily_constraints()
        op.execute(
            "update daily_source_files set report_type = 'ad_product_report' where report_type = 'ad_report'"
        )
        _create_daily_constraints()


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    dialect = bind.dialect.name

    if inspector.has_table('analysis_source_files'):
        _drop_analysis_constraints()
        op.execute(
            "update analysis_source_files set report_type = 'ad_report' where report_type = 'ad_product_report'"
        )
        with op.batch_alter_table('analysis_source_files') as batch_op:
            batch_op.create_check_constraint(
                'ck_analysis_sources_report_type',
                "report_type in ('business_report', 'payment_report', 'ad_report', 'sales_report', 'inventory_report')",
            )
            batch_op.create_check_constraint(
                'ck_analysis_sources_period_or_snapshot',
                "("
                "report_type in ('business_report', 'payment_report', 'ad_report', 'sales_report') "
                'and period_start_date is not null '
                'and period_end_date is not null '
                'and period_start_date <= period_end_date '
                'and snapshot_at is null'
                ") or ("
                "report_type = 'inventory_report' "
                'and snapshot_at is not null'
                ')',
            )
        op.execute('drop index if exists uq_analysis_sources_period_current')
        if dialect == 'sqlite':
            op.execute(
                'create unique index if not exists uq_analysis_sources_period_current '
                'on analysis_source_files (project_id, report_type, country, period_start_date, period_end_date) '
                "where report_type in ('business_report', 'payment_report', 'ad_report', 'sales_report') and is_current = 1"
            )
        else:
            op.execute(
                'create unique index if not exists uq_analysis_sources_period_current '
                'on analysis_source_files (project_id, report_type, country, period_start_date, period_end_date) '
                "where report_type in ('business_report', 'payment_report', 'ad_report', 'sales_report') and is_current is true"
            )

    if inspector.has_table('daily_source_files'):
        _drop_daily_constraints()
        op.execute(
            "update daily_source_files set report_type = 'ad_report' where report_type = 'ad_product_report'"
        )
        with op.batch_alter_table('daily_source_files') as batch_op:
            batch_op.create_check_constraint(
                'ck_daily_sources_report_type',
                "report_type in ('sales_report', 'ad_report')",
            )
