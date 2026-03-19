"""add report_date to analysis source files

Revision ID: 20260318_053
Revises: 20260318_052
Create Date: 2026-03-18 18:30:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260318_053'
down_revision: Union[str, None] = '20260318_052'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table('analysis_source_files'):
        return

    columns = {column['name'] for column in inspector.get_columns('analysis_source_files')}
    if 'report_date' not in columns:
        op.add_column('analysis_source_files', sa.Column('report_date', sa.Date(), nullable=True))

    op.execute(
        'update analysis_source_files '
        'set report_date = period_start_date '
        "where report_type = 'business_report' "
        'and period_start_date is not null '
        'and period_end_date is not null '
        'and period_start_date = period_end_date '
        'and report_date is null'
    )

    indexes = {index['name'] for index in inspector.get_indexes('analysis_source_files')}
    if 'idx_analysis_sources_project_type_country_report_date' not in indexes:
        op.create_index(
            'idx_analysis_sources_project_type_country_report_date',
            'analysis_source_files',
            ['project_id', 'report_type', 'country', 'report_date'],
            unique=False,
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table('analysis_source_files'):
        return

    indexes = {index['name'] for index in inspector.get_indexes('analysis_source_files')}
    if 'idx_analysis_sources_project_type_country_report_date' in indexes:
        op.drop_index(
            'idx_analysis_sources_project_type_country_report_date',
            table_name='analysis_source_files',
        )

    columns = {column['name'] for column in inspector.get_columns('analysis_source_files')}
    if 'report_date' in columns:
        op.drop_column('analysis_source_files', 'report_date')
