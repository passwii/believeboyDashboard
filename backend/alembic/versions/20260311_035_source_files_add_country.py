"""add country to analysis and daily source files

Revision ID: 20260311_035
Revises: 20260310_034
Create Date: 2026-03-11 18:30:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260311_035'
down_revision: Union[str, None] = '20260310_034'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    analysis_columns = {column['name'] for column in inspector.get_columns('analysis_source_files')}
    if 'country' not in analysis_columns:
        with op.batch_alter_table('analysis_source_files') as batch_op:
            batch_op.add_column(sa.Column('country', sa.String(length=2), nullable=False, server_default='US'))
    op.execute("update analysis_source_files set country = 'US' where country is null or trim(country) = ''")

    with op.batch_alter_table('analysis_source_files') as batch_op:
        batch_op.drop_constraint('analysis_sources_period_version_key', type_='unique')
        batch_op.create_unique_constraint(
            'analysis_sources_period_version_key',
            ['project_id', 'report_type', 'country', 'period_start_date', 'period_end_date', 'version'],
        )

    op.execute('drop index if exists idx_analysis_sources_project_type_period')
    op.execute('create index if not exists idx_analysis_sources_country on analysis_source_files (country)')
    op.execute(
        'create index if not exists idx_analysis_sources_project_type_country_period '
        'on analysis_source_files (project_id, report_type, country, period_start_date, period_end_date)'
    )
    op.execute('drop index if exists uq_analysis_sources_period_current')
    op.execute('drop index if exists uq_analysis_sources_inventory_current')
    if bind.dialect.name == 'sqlite':
        op.execute(
            'create unique index if not exists uq_analysis_sources_period_current '
            'on analysis_source_files (project_id, report_type, country, period_start_date, period_end_date) '
            "where report_type in ('business_report', 'payment_report', 'ad_report', 'sales_report') and is_current = 1"
        )
        op.execute(
            'create unique index if not exists uq_analysis_sources_inventory_current '
            'on analysis_source_files (project_id, report_type, country) '
            "where report_type = 'inventory_report' and is_current = 1"
        )
    else:
        op.execute(
            'create unique index if not exists uq_analysis_sources_period_current '
            'on analysis_source_files (project_id, report_type, country, period_start_date, period_end_date) '
            "where report_type in ('business_report', 'payment_report', 'ad_report', 'sales_report') and is_current is true"
        )
        op.execute(
            'create unique index if not exists uq_analysis_sources_inventory_current '
            'on analysis_source_files (project_id, report_type, country) '
            "where report_type = 'inventory_report' and is_current is true"
        )

    daily_columns = {column['name'] for column in inspector.get_columns('daily_source_files')}
    if 'country' not in daily_columns:
        with op.batch_alter_table('daily_source_files') as batch_op:
            batch_op.add_column(sa.Column('country', sa.String(length=2), nullable=False, server_default='US'))
    op.execute("update daily_source_files set country = 'US' where country is null or trim(country) = ''")

    with op.batch_alter_table('daily_source_files') as batch_op:
        batch_op.drop_constraint('daily_sources_date_version_key', type_='unique')
        batch_op.create_unique_constraint(
            'daily_sources_date_version_key',
            ['project_id', 'report_type', 'country', 'report_date', 'version'],
        )

    op.execute('drop index if exists idx_daily_sources_project_type_date')
    op.execute('create index if not exists idx_daily_sources_country on daily_source_files (country)')
    op.execute(
        'create index if not exists idx_daily_sources_project_type_country_date '
        'on daily_source_files (project_id, report_type, country, report_date)'
    )
    op.execute('drop index if exists uq_daily_sources_current')
    if bind.dialect.name == 'sqlite':
        op.execute(
            'create unique index if not exists uq_daily_sources_current '
            'on daily_source_files (project_id, report_type, country, report_date) '
            'where is_current = 1'
        )
    else:
        op.execute(
            'create unique index if not exists uq_daily_sources_current '
            'on daily_source_files (project_id, report_type, country, report_date) '
            'where is_current is true'
        )


def downgrade() -> None:
    op.execute('drop index if exists uq_daily_sources_current')
    op.execute('drop index if exists idx_daily_sources_project_type_country_date')
    op.execute('drop index if exists idx_daily_sources_country')
    with op.batch_alter_table('daily_source_files') as batch_op:
        batch_op.drop_constraint('daily_sources_date_version_key', type_='unique')
        batch_op.create_unique_constraint(
            'daily_sources_date_version_key',
            ['project_id', 'report_type', 'report_date', 'version'],
        )
        batch_op.drop_column('country')
    op.execute(
        'create index if not exists idx_daily_sources_project_type_date '
        'on daily_source_files (project_id, report_type, report_date)'
    )
    if op.get_bind().dialect.name == 'sqlite':
        op.execute(
            'create unique index if not exists uq_daily_sources_current '
            'on daily_source_files (project_id, report_type, report_date) '
            'where is_current = 1'
        )
    else:
        op.execute(
            'create unique index if not exists uq_daily_sources_current '
            'on daily_source_files (project_id, report_type, report_date) '
            'where is_current is true'
        )

    op.execute('drop index if exists uq_analysis_sources_inventory_current')
    op.execute('drop index if exists uq_analysis_sources_period_current')
    op.execute('drop index if exists idx_analysis_sources_project_type_country_period')
    op.execute('drop index if exists idx_analysis_sources_country')
    with op.batch_alter_table('analysis_source_files') as batch_op:
        batch_op.drop_constraint('analysis_sources_period_version_key', type_='unique')
        batch_op.create_unique_constraint(
            'analysis_sources_period_version_key',
            ['project_id', 'report_type', 'period_start_date', 'period_end_date', 'version'],
        )
        batch_op.drop_column('country')
    op.execute(
        'create index if not exists idx_analysis_sources_project_type_period '
        'on analysis_source_files (project_id, report_type, period_start_date, period_end_date)'
    )
    if op.get_bind().dialect.name == 'sqlite':
        op.execute(
            'create unique index if not exists uq_analysis_sources_period_current '
            'on analysis_source_files (project_id, report_type, period_start_date, period_end_date) '
            "where report_type in ('business_report', 'payment_report', 'ad_report') and is_current = 1"
        )
        op.execute(
            'create unique index if not exists uq_analysis_sources_inventory_current '
            'on analysis_source_files (project_id, report_type) '
            "where report_type = 'inventory_report' and is_current = 1"
        )
    else:
        op.execute(
            'create unique index if not exists uq_analysis_sources_period_current '
            'on analysis_source_files (project_id, report_type, period_start_date, period_end_date) '
            "where report_type in ('business_report', 'payment_report', 'ad_report') and is_current is true"
        )
        op.execute(
            'create unique index if not exists uq_analysis_sources_inventory_current '
            'on analysis_source_files (project_id, report_type) '
            "where report_type = 'inventory_report' and is_current is true"
        )
