"""monthly report add project/month fields and drop sku stats

Revision ID: 20260227_007
Revises: 20260227_006
Create Date: 2026-02-27 00:30:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260227_007'
down_revision: Union[str, None] = '20260227_006'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    dialect = bind.dialect.name

    if inspector.has_table('monthly_reports'):
        report_columns = {column['name'] for column in inspector.get_columns('monthly_reports')}
        if 'project_name' not in report_columns:
            op.add_column(
                'monthly_reports',
                sa.Column('project_name', sa.String(length=255), nullable=False, server_default=sa.text("''")),
            )
            if inspector.has_table('projects'):
                if dialect == 'postgresql':
                    op.execute(
                        """
                        update monthly_reports mr
                        set project_name = p.project_name
                        from projects p
                        where p.id = mr.project_id
                          and (mr.project_name = '' or mr.project_name is null)
                        """
                    )
                else:
                    op.execute(
                        """
                        update monthly_reports
                        set project_name = (
                            select projects.project_name
                            from projects
                            where projects.id = monthly_reports.project_id
                        )
                        where (project_name = '' or project_name is null)
                        """
                    )

    if inspector.has_table('monthly_report_transactions'):
        tx_columns = {column['name'] for column in inspector.get_columns('monthly_report_transactions')}
        if 'project_name' not in tx_columns:
            op.add_column(
                'monthly_report_transactions',
                sa.Column('project_name', sa.String(length=255), nullable=False, server_default=sa.text("''")),
            )
        if 'report_month' not in tx_columns:
            op.add_column(
                'monthly_report_transactions',
                sa.Column('report_month', sa.Date(), nullable=False, server_default=sa.text("'1970-01-01'")),
            )
        if dialect == 'postgresql':
            op.execute(
                """
                update monthly_report_transactions t
                set project_name = mr.project_name,
                    report_month = mr.report_month
                from monthly_reports mr
                where mr.id = t.report_id
                """
            )
        else:
            op.execute(
                """
                update monthly_report_transactions
                set project_name = (
                        select mr.project_name
                        from monthly_reports mr
                        where mr.id = monthly_report_transactions.report_id
                    ),
                    report_month = (
                        select mr.report_month
                        from monthly_reports mr
                        where mr.id = monthly_report_transactions.report_id
                    )
                """
            )
        op.execute('create index if not exists idx_monthly_transactions_project_month on monthly_report_transactions (project_name, report_month)')

    if inspector.has_table('monthly_report_pt3_calculation'):
        pt3_columns = {column['name'] for column in inspector.get_columns('monthly_report_pt3_calculation')}
        if 'project_name' not in pt3_columns:
            op.add_column(
                'monthly_report_pt3_calculation',
                sa.Column('project_name', sa.String(length=255), nullable=False, server_default=sa.text("''")),
            )
        if 'report_month' not in pt3_columns:
            op.add_column(
                'monthly_report_pt3_calculation',
                sa.Column('report_month', sa.Date(), nullable=False, server_default=sa.text("'1970-01-01'")),
            )
        if dialect == 'postgresql':
            op.execute(
                """
                update monthly_report_pt3_calculation p3
                set project_name = mr.project_name,
                    report_month = mr.report_month
                from monthly_reports mr
                where mr.id = p3.report_id
                """
            )
        else:
            op.execute(
                """
                update monthly_report_pt3_calculation
                set project_name = (
                        select mr.project_name
                        from monthly_reports mr
                        where mr.id = monthly_report_pt3_calculation.report_id
                    ),
                    report_month = (
                        select mr.report_month
                        from monthly_reports mr
                        where mr.id = monthly_report_pt3_calculation.report_id
                    )
                """
            )
        op.execute('create index if not exists idx_monthly_pt3_project_month on monthly_report_pt3_calculation (project_name, report_month)')

    if inspector.has_table('monthly_report_pt4_calculation'):
        pt4_columns = {column['name'] for column in inspector.get_columns('monthly_report_pt4_calculation')}
        if 'project_name' not in pt4_columns:
            op.add_column(
                'monthly_report_pt4_calculation',
                sa.Column('project_name', sa.String(length=255), nullable=False, server_default=sa.text("''")),
            )
        if 'report_month' not in pt4_columns:
            op.add_column(
                'monthly_report_pt4_calculation',
                sa.Column('report_month', sa.Date(), nullable=False, server_default=sa.text("'1970-01-01'")),
            )
        if dialect == 'postgresql':
            op.execute(
                """
                update monthly_report_pt4_calculation p4
                set project_name = mr.project_name,
                    report_month = mr.report_month
                from monthly_reports mr
                where mr.id = p4.report_id
                """
            )
        else:
            op.execute(
                """
                update monthly_report_pt4_calculation
                set project_name = (
                        select mr.project_name
                        from monthly_reports mr
                        where mr.id = monthly_report_pt4_calculation.report_id
                    ),
                    report_month = (
                        select mr.report_month
                        from monthly_reports mr
                        where mr.id = monthly_report_pt4_calculation.report_id
                    )
                """
            )
        op.execute('create index if not exists idx_monthly_pt4_project_month on monthly_report_pt4_calculation (project_name, report_month)')

    if inspector.has_table('monthly_report_sku_stats'):
        op.execute('drop table if exists monthly_report_sku_stats')


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if inspector.has_table('monthly_report_pt4_calculation'):
        columns = {column['name'] for column in inspector.get_columns('monthly_report_pt4_calculation')}
        op.execute('drop index if exists idx_monthly_pt4_project_month')
        if 'report_month' in columns:
            op.drop_column('monthly_report_pt4_calculation', 'report_month')
        if 'project_name' in columns:
            op.drop_column('monthly_report_pt4_calculation', 'project_name')

    if inspector.has_table('monthly_report_pt3_calculation'):
        columns = {column['name'] for column in inspector.get_columns('monthly_report_pt3_calculation')}
        op.execute('drop index if exists idx_monthly_pt3_project_month')
        if 'report_month' in columns:
            op.drop_column('monthly_report_pt3_calculation', 'report_month')
        if 'project_name' in columns:
            op.drop_column('monthly_report_pt3_calculation', 'project_name')

    if inspector.has_table('monthly_report_transactions'):
        columns = {column['name'] for column in inspector.get_columns('monthly_report_transactions')}
        op.execute('drop index if exists idx_monthly_transactions_project_month')
        if 'report_month' in columns:
            op.drop_column('monthly_report_transactions', 'report_month')
        if 'project_name' in columns:
            op.drop_column('monthly_report_transactions', 'project_name')

    if inspector.has_table('monthly_reports'):
        columns = {column['name'] for column in inspector.get_columns('monthly_reports')}
        if 'project_name' in columns:
            op.drop_column('monthly_reports', 'project_name')
