"""add country dimension to monthly reports

Revision ID: 20260409_084
Revises: 20260409_083
Create Date: 2026-04-09 17:10:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260409_084'
down_revision: Union[str, None] = '20260409_083'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_unique_constraint(inspector: sa.Inspector, table_name: str, constraint_name: str) -> bool:
    return any(item.get('name') == constraint_name for item in inspector.get_unique_constraints(table_name))


def _has_column(inspector: sa.Inspector, table_name: str, column_name: str) -> bool:
    return any(column.get('name') == column_name for column in inspector.get_columns(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table('monthly_reports'):
        return

    if not _has_column(inspector, 'monthly_reports', 'country'):
        with op.batch_alter_table('monthly_reports') as batch_op:
            batch_op.add_column(sa.Column('country', sa.String(length=2), nullable=True, server_default='US'))

    op.execute("update monthly_reports set country = 'US' where country is null or trim(country) = ''")

    with op.batch_alter_table('monthly_reports') as batch_op:
        batch_op.alter_column('country', existing_type=sa.String(length=2), nullable=False, server_default='US')

    inspector = sa.inspect(bind)

    if _has_unique_constraint(inspector, 'monthly_reports', 'monthly_reports_project_month_version_key'):
        with op.batch_alter_table('monthly_reports') as batch_op:
            batch_op.drop_constraint('monthly_reports_project_month_version_key', type_='unique')

    if not _has_unique_constraint(inspector, 'monthly_reports', 'monthly_reports_project_country_month_version_key'):
        with op.batch_alter_table('monthly_reports') as batch_op:
            batch_op.create_unique_constraint(
                'monthly_reports_project_country_month_version_key',
                ['project_id', 'country', 'report_month', 'version'],
            )

    op.execute('drop index if exists idx_monthly_reports_project_month')
    op.execute('drop index if exists idx_monthly_reports_project_month_current')
    op.execute('drop index if exists uq_monthly_reports_project_month_current')

    op.execute(
        'create index if not exists idx_monthly_reports_project_country_month '
        'on monthly_reports (project_id, country, report_month)'
    )
    op.execute(
        'create index if not exists idx_monthly_reports_project_country_month_current '
        'on monthly_reports (project_id, country, report_month, is_current)'
    )

    if bind.dialect.name == 'sqlite':
        op.execute(
            'create unique index if not exists uq_monthly_reports_project_country_month_current '
            'on monthly_reports (project_id, country, report_month) where is_current = 1'
        )
    else:
        op.execute(
            'create unique index if not exists uq_monthly_reports_project_country_month_current '
            'on monthly_reports (project_id, country, report_month) where is_current is true'
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table('monthly_reports'):
        return

    op.execute('drop index if exists uq_monthly_reports_project_country_month_current')
    op.execute('drop index if exists idx_monthly_reports_project_country_month_current')
    op.execute('drop index if exists idx_monthly_reports_project_country_month')

    inspector = sa.inspect(bind)
    if _has_unique_constraint(inspector, 'monthly_reports', 'monthly_reports_project_country_month_version_key'):
        with op.batch_alter_table('monthly_reports') as batch_op:
            batch_op.drop_constraint('monthly_reports_project_country_month_version_key', type_='unique')

    if not _has_unique_constraint(inspector, 'monthly_reports', 'monthly_reports_project_month_version_key'):
        with op.batch_alter_table('monthly_reports') as batch_op:
            batch_op.create_unique_constraint(
                'monthly_reports_project_month_version_key',
                ['project_id', 'report_month', 'version'],
            )

    op.execute(
        'create index if not exists idx_monthly_reports_project_month '
        'on monthly_reports (project_id, report_month)'
    )
    op.execute(
        'create index if not exists idx_monthly_reports_project_month_current '
        'on monthly_reports (project_id, report_month, is_current)'
    )

    if bind.dialect.name == 'sqlite':
        op.execute(
            'create unique index if not exists uq_monthly_reports_project_month_current '
            'on monthly_reports (project_id, report_month) where is_current = 1'
        )
    else:
        op.execute(
            'create unique index if not exists uq_monthly_reports_project_month_current '
            'on monthly_reports (project_id, report_month) where is_current is true'
        )

    inspector = sa.inspect(bind)
    if _has_column(inspector, 'monthly_reports', 'country'):
        with op.batch_alter_table('monthly_reports') as batch_op:
            batch_op.drop_column('country')
