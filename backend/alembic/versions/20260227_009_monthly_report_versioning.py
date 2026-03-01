"""monthly report versioning for historical uploads

Revision ID: 20260227_009
Revises: 20260227_008
Create Date: 2026-02-27 02:30:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260227_009'
down_revision: Union[str, None] = '20260227_008'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_unique_constraint(inspector, table_name: str, constraint_name: str) -> bool:
    constraints = inspector.get_unique_constraints(table_name)
    return any(item.get('name') == constraint_name for item in constraints)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    dialect = bind.dialect.name

    if not inspector.has_table('monthly_reports'):
        return

    columns = {column['name'] for column in inspector.get_columns('monthly_reports')}

    with op.batch_alter_table('monthly_reports') as batch_op:
        if 'version' not in columns:
            batch_op.add_column(sa.Column('version', sa.Integer(), nullable=False, server_default=sa.text('1')))
        if 'is_current' not in columns:
            batch_op.add_column(sa.Column('is_current', sa.Boolean(), nullable=False, server_default=sa.text('true')))
        if 'superseded_at' not in columns:
            batch_op.add_column(sa.Column('superseded_at', sa.DateTime(timezone=True), nullable=True))

    op.execute("update monthly_reports set version = 1 where version is null or version < 1")
    if dialect == 'sqlite':
        op.execute("update monthly_reports set is_current = 1 where is_current is null")
    else:
        op.execute("update monthly_reports set is_current = true where is_current is null")

    inspector = sa.inspect(bind)
    if _has_unique_constraint(inspector, 'monthly_reports', 'monthly_reports_project_month_key'):
        with op.batch_alter_table('monthly_reports') as batch_op:
            batch_op.drop_constraint('monthly_reports_project_month_key', type_='unique')

    inspector = sa.inspect(bind)
    if not _has_unique_constraint(inspector, 'monthly_reports', 'monthly_reports_project_month_version_key'):
        with op.batch_alter_table('monthly_reports') as batch_op:
            batch_op.create_unique_constraint(
                'monthly_reports_project_month_version_key',
                ['project_id', 'report_month', 'version'],
            )

    op.execute(
        'create index if not exists idx_monthly_reports_project_month_current '
        'on monthly_reports (project_id, report_month, is_current)'
    )

    if dialect == 'sqlite':
        op.execute(
            'create unique index if not exists uq_monthly_reports_project_month_current '
            'on monthly_reports (project_id, report_month) where is_current = 1'
        )
    else:
        op.execute(
            'create unique index if not exists uq_monthly_reports_project_month_current '
            'on monthly_reports (project_id, report_month) where is_current is true'
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table('monthly_reports'):
        return

    op.execute('drop index if exists uq_monthly_reports_project_month_current')
    op.execute('drop index if exists idx_monthly_reports_project_month_current')

    inspector = sa.inspect(bind)
    if _has_unique_constraint(inspector, 'monthly_reports', 'monthly_reports_project_month_version_key'):
        with op.batch_alter_table('monthly_reports') as batch_op:
            batch_op.drop_constraint('monthly_reports_project_month_version_key', type_='unique')

    op.execute(
        """
        delete from monthly_reports
        where id not in (
            select id
            from (
                select
                    id,
                    row_number() over (
                        partition by project_id, report_month
                        order by is_current desc, version desc, id desc
                    ) as rn
                from monthly_reports
            ) dedupe
            where rn = 1
        )
        """
    )

    inspector = sa.inspect(bind)
    if not _has_unique_constraint(inspector, 'monthly_reports', 'monthly_reports_project_month_key'):
        with op.batch_alter_table('monthly_reports') as batch_op:
            batch_op.create_unique_constraint('monthly_reports_project_month_key', ['project_id', 'report_month'])

    columns = {column['name'] for column in inspector.get_columns('monthly_reports')}
    with op.batch_alter_table('monthly_reports') as batch_op:
        if 'superseded_at' in columns:
            batch_op.drop_column('superseded_at')
        if 'is_current' in columns:
            batch_op.drop_column('is_current')
        if 'version' in columns:
            batch_op.drop_column('version')
