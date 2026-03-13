"""add project commission fields and user operator name

Revision ID: 20260228_011
Revises: 20260227_010
Create Date: 2026-02-28 18:20:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260228_011'
down_revision: Union[str, None] = '20260227_010'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_column(inspector: sa.Inspector, table_name: str, column_name: str) -> bool:
    return column_name in {column['name'] for column in inspector.get_columns(table_name)}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    dialect = bind.dialect.name
    has_projects = inspector.has_table('projects')
    has_user_accounts = inspector.has_table('user_accounts')

    if has_projects and _has_column(inspector, 'projects', 'project_operator') is False:
        op.add_column('projects', sa.Column('project_operator', sa.String(length=255), nullable=True))
    if has_projects and _has_column(inspector, 'projects', 'commission_basis') is False:
        op.add_column('projects', sa.Column('commission_basis', sa.String(length=32), nullable=True))
    if has_projects and _has_column(inspector, 'projects', 'commission_rate') is False:
        op.add_column('projects', sa.Column('commission_rate', sa.Numeric(7, 4), nullable=True))

    if has_user_accounts and _has_column(inspector, 'user_accounts', 'operator_name_zh') is False:
        op.add_column('user_accounts', sa.Column('operator_name_zh', sa.Text(), nullable=True))

    if dialect != 'sqlite' and has_projects:
        op.execute('alter table projects drop constraint if exists projects_commission_basis_check')
        op.execute(
            "alter table projects add constraint projects_commission_basis_check "
            "check (commission_basis is null or commission_basis in ('sales_amount', 'cash_received', 'profit_margin'))"
        )
        op.execute('alter table projects drop constraint if exists projects_commission_rate_check')
        op.execute(
            'alter table projects add constraint projects_commission_rate_check '
            'check (commission_rate is null or (commission_rate >= 0 and commission_rate <= 1))'
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    dialect = bind.dialect.name
    has_projects = inspector.has_table('projects')
    has_user_accounts = inspector.has_table('user_accounts')

    if dialect != 'sqlite' and has_projects:
        op.execute('alter table projects drop constraint if exists projects_commission_rate_check')
        op.execute('alter table projects drop constraint if exists projects_commission_basis_check')

    inspector = sa.inspect(bind)
    if has_user_accounts and _has_column(inspector, 'user_accounts', 'operator_name_zh'):
        op.drop_column('user_accounts', 'operator_name_zh')
    if has_projects and _has_column(inspector, 'projects', 'commission_rate'):
        op.drop_column('projects', 'commission_rate')
    if has_projects and _has_column(inspector, 'projects', 'commission_basis'):
        op.drop_column('projects', 'commission_basis')
    if has_projects and _has_column(inspector, 'projects', 'project_operator'):
        op.drop_column('projects', 'project_operator')
