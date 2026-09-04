"""delete bad duplicate yuehan feb16 payment report

Revision ID: 20260320_065
Revises: 20260319_064
Create Date: 2026-03-20 10:30:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260320_065'
down_revision: Union[str, None] = '20260319_064'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


PROJECT_NAME = '玥涵'
REPORT_TYPE = 'payment_report'
WRONG_PERIOD_START = '2026-02-16'
WRONG_PERIOD_END = '2026-03-22'
CORRECT_PERIOD_END = '2026-02-22'
TARGET_FILENAME = '2026feb16-2026feb22customunifiedtransaction.csv'


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    required_tables = {'projects', 'analysis_source_files'}
    if not required_tables.issubset(set(inspector.get_table_names())):
        return

    source_columns = {column['name'] for column in inspector.get_columns('analysis_source_files')}
    required_source_columns = {
        'id',
        'project_id',
        'report_type',
        'country',
        'period_start_date',
        'period_end_date',
        'original_filename',
        'upload_file_id',
    }
    if not required_source_columns.issubset(source_columns):
        return

    project_id = bind.execute(
        sa.text(
            """
            select id
            from projects
            where project_name = :project_name
            limit 1
            """
        ),
        {'project_name': PROJECT_NAME},
    ).scalar()
    if project_id is None:
        return

    delete_ids = [
        int(row_id)
        for row_id in bind.execute(
            sa.text(
                """
                select wrong.id
                from analysis_source_files wrong
                where wrong.project_id = :project_id
                  and wrong.report_type = :report_type
                  and wrong.period_start_date = :wrong_period_start
                  and wrong.period_end_date = :wrong_period_end
                  and wrong.original_filename = :target_filename
                  and exists (
                    select 1
                    from analysis_source_files correct
                    where correct.project_id = wrong.project_id
                      and correct.report_type = wrong.report_type
                      and correct.country = wrong.country
                      and correct.upload_file_id = wrong.upload_file_id
                      and correct.original_filename = wrong.original_filename
                      and correct.period_start_date = :wrong_period_start
                      and correct.period_end_date = :correct_period_end
                      and correct.id <> wrong.id
                  )
                """
            ),
            {
                'project_id': project_id,
                'report_type': REPORT_TYPE,
                'wrong_period_start': WRONG_PERIOD_START,
                'wrong_period_end': WRONG_PERIOD_END,
                'correct_period_end': CORRECT_PERIOD_END,
                'target_filename': TARGET_FILENAME,
            },
        ).scalars().all()
    ]

    if not delete_ids:
        return

    bind.execute(
        sa.text(
            """
            delete from analysis_source_files
            where id in :delete_ids
            """
        ).bindparams(sa.bindparam('delete_ids', expanding=True)),
        {'delete_ids': delete_ids},
    )


def downgrade() -> None:
    # Irreversible data cleanup. Deleted duplicate rows are not restored.
    return
