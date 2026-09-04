"""add product analysis pt1 calculation table

Revision ID: 20260228_013
Revises: 20260228_012
Create Date: 2026-02-28 23:10:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260228_013'
down_revision: Union[str, None] = '20260228_012'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

BIGINT_SQLITE = sa.BigInteger().with_variant(sa.Integer(), 'sqlite')


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table('analysis_pt1_calculation'):
        op.create_table(
            'analysis_pt1_calculation',
            sa.Column('id', BIGINT_SQLITE, primary_key=True, autoincrement=True),
            sa.Column('project_id', BIGINT_SQLITE, nullable=False),
            sa.Column('project_name', sa.String(length=255), nullable=False),
            sa.Column('report_start_date', sa.Date(), nullable=False),
            sa.Column('report_end_date', sa.Date(), nullable=False),
            sa.Column('version', sa.Integer(), nullable=False, server_default=sa.text('1')),
            sa.Column('is_current', sa.Boolean(), nullable=False, server_default=sa.text('true')),
            sa.Column('superseded_at', sa.DateTime(timezone=True), nullable=True),
            sa.Column('row_count', sa.Integer(), nullable=False, server_default=sa.text('0')),
            sa.Column('summary_row', sa.JSON(), nullable=False),
            sa.Column('result_file_path', sa.String(length=1024), nullable=True),
            sa.Column('calculation_version', sa.Integer(), nullable=False, server_default=sa.text('1')),
            sa.Column('computed_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('CURRENT_TIMESTAMP')),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('CURRENT_TIMESTAMP')),
            sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('CURRENT_TIMESTAMP')),
            sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
            sa.UniqueConstraint(
                'project_id',
                'report_start_date',
                'report_end_date',
                'version',
                name='analysis_pt1_project_period_version_key',
            ),
            sa.CheckConstraint('version >= 1', name='ck_analysis_pt1_version_positive'),
            sa.CheckConstraint('report_start_date <= report_end_date', name='ck_analysis_pt1_period_valid'),
        )

    op.execute('create index if not exists idx_analysis_pt1_project_id on analysis_pt1_calculation (project_id)')
    op.execute(
        'create index if not exists idx_analysis_pt1_project_period '
        'on analysis_pt1_calculation (project_id, report_start_date, report_end_date)'
    )
    op.execute(
        'create index if not exists idx_analysis_pt1_project_period_current '
        'on analysis_pt1_calculation (project_id, report_start_date, report_end_date, is_current)'
    )


def downgrade() -> None:
    op.execute('drop index if exists idx_analysis_pt1_project_period_current')
    op.execute('drop index if exists idx_analysis_pt1_project_period')
    op.execute('drop index if exists idx_analysis_pt1_project_id')
    op.execute('drop table if exists analysis_pt1_calculation')
