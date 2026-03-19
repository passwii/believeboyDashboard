"""delete bad yuehan payment report history

Revision ID: 20260319_063
Revises: 20260319_062
Create Date: 2026-03-19 18:10:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260319_063'
down_revision: Union[str, None] = '20260319_062'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


YUEHAN_PROJECT_NAME = '玥涵'
EARLY_HISTORY_CUTOFF = '2026-03-01 00:00:00+08:00'
TARGET_PERIOD_START = '2025-11-24'
TARGET_PERIOD_END = '2025-11-30'
WRONG_PERIOD_END = '2025-12-30'


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
        'period_start_date',
        'period_end_date',
        'created_at',
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
        {'project_name': YUEHAN_PROJECT_NAME},
    ).scalar()
    if project_id is None:
        return

    keep_source_id = bind.execute(
        sa.text(
            """
            select id
            from analysis_source_files
            where project_id = :project_id
              and report_type = 'payment_report'
              and period_start_date = :period_start_date
              and period_end_date = :period_end_date
              and created_at < :created_at_cutoff
            order by created_at desc, id desc
            limit 1
            """
        ),
        {
            'project_id': project_id,
            'period_start_date': TARGET_PERIOD_START,
            'period_end_date': TARGET_PERIOD_END,
            'created_at_cutoff': EARLY_HISTORY_CUTOFF,
        },
    ).scalar()

    delete_ids = [
        int(row_id)
        for row_id in bind.execute(
            sa.text(
                """
                select id
                from analysis_source_files
                where project_id = :project_id
                  and report_type = 'payment_report'
                  and created_at < :created_at_cutoff
                  and (
                    (
                      period_start_date = :period_start_date
                      and period_end_date = :wrong_period_end
                    )
                    or (
                      period_start_date = :period_start_date
                      and period_end_date = :period_end_date
                      and (:keep_source_id is null or id <> :keep_source_id)
                    )
                  )
                order by created_at asc, id asc
                """
            ),
            {
                'project_id': project_id,
                'created_at_cutoff': EARLY_HISTORY_CUTOFF,
                'period_start_date': TARGET_PERIOD_START,
                'period_end_date': TARGET_PERIOD_END,
                'wrong_period_end': WRONG_PERIOD_END,
                'keep_source_id': keep_source_id,
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
    # Irreversible data cleanup. Deleted historical rows are not restored.
    return
