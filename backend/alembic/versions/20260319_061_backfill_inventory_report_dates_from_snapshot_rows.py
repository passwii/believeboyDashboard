"""backfill inventory report dates from snapshot rows

Revision ID: 20260319_061
Revises: 20260319_060
Create Date: 2026-03-19 16:20:00.000000
"""

from __future__ import annotations

import csv
from datetime import date, datetime
from pathlib import Path
from typing import Any, Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260319_061'
down_revision: Union[str, None] = '20260319_060'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _parse_snapshot_date(value: Any) -> date | None:
    text = str(value or '').strip()
    if not text:
        return None

    normalized = text.replace('Z', '+00:00')
    for parser in (
        date.fromisoformat,
        lambda item: datetime.fromisoformat(item).date(),
    ):
        try:
            return parser(normalized)
        except ValueError:
            continue
    return None


def _extract_snapshot_date_from_raw_row(raw_row: Any) -> date | None:
    if not isinstance(raw_row, dict):
        return None

    for key, value in raw_row.items():
        if str(key or '').strip().lower() == 'snapshot-date':
            return _parse_snapshot_date(value)
    return None


def _read_inventory_snapshot_date(path: str | None) -> date | None:
    file_path = Path(str(path or '').strip())
    if not file_path.exists() or not file_path.is_file():
        return None

    with file_path.open('r', encoding='utf-8-sig', newline='') as handle:
        reader = csv.DictReader(handle, delimiter='\t')
        if not reader.fieldnames:
            return None
        snapshot_column = next((field for field in reader.fieldnames if str(field).strip().lower() == 'snapshot-date'), None)
        if snapshot_column is None:
            return None
        for row in reader:
            parsed = _parse_snapshot_date(row.get(snapshot_column))
            if parsed is not None:
                return parsed
    return None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    required_tables = {'analysis_source_files', 'inventory_snapshot_rows'}
    if not required_tables.issubset(set(inspector.get_table_names())):
        return

    source_columns = {column['name'] for column in inspector.get_columns('analysis_source_files')}
    required_source_columns = {
        'id',
        'project_id',
        'country',
        'report_type',
        'report_date',
        'upload_file_id',
        'upload_file_path',
        'snapshot_at',
    }
    if not required_source_columns.issubset(source_columns):
        return

    snapshot_columns = {column['name'] for column in inspector.get_columns('inventory_snapshot_rows')}
    required_snapshot_columns = {'source_file_id', 'source_row_no', 'raw_row'}
    if not required_snapshot_columns.issubset(snapshot_columns):
        return

    has_report_upload_statuses = inspector.has_table('report_upload_statuses')
    report_status_columns = (
        {column['name'] for column in inspector.get_columns('report_upload_statuses')}
        if has_report_upload_statuses
        else set()
    )
    can_use_report_statuses = {'project_id', 'report_type', 'country', 'report_date', 'upload_file_id'}.issubset(
        report_status_columns
    )

    rows = bind.execute(
        sa.text(
            """
            select
                source.id,
                source.project_id,
                source.country,
                source.upload_file_id,
                source.upload_file_path,
                source.snapshot_at,
                snapshot.raw_row
            from analysis_source_files source
            left join lateral (
                select raw_row
                from inventory_snapshot_rows
                where source_file_id = source.id
                order by source_row_no asc
                limit 1
            ) snapshot on true
            where source.report_type = 'inventory_report'
              and source.report_date is null
            order by source.id asc
            """
        )
    ).mappings().all()

    for row in rows:
        report_date = _extract_snapshot_date_from_raw_row(row.get('raw_row'))
        if report_date is None:
            report_date = _read_inventory_snapshot_date(row.get('upload_file_path'))

        if report_date is None and can_use_report_statuses:
            report_date = bind.execute(
                sa.text(
                    """
                    select report_date
                    from report_upload_statuses
                    where project_id = :project_id
                      and report_type = 'inventory_report'
                      and country = :country
                      and upload_file_id = :upload_file_id
                    order by id desc
                    limit 1
                    """
                ),
                {
                    'project_id': row['project_id'],
                    'country': row['country'],
                    'upload_file_id': row['upload_file_id'],
                },
            ).scalar()

        if report_date is None and row.get('snapshot_at') is not None:
            snapshot_at = row['snapshot_at']
            if isinstance(snapshot_at, datetime):
                report_date = snapshot_at.date()

        if report_date is None:
            continue

        bind.execute(
            sa.text(
                """
                update analysis_source_files
                set report_date = :report_date,
                    updated_at = CURRENT_TIMESTAMP
                where id = :id
                  and report_date is null
                """
            ),
            {
                'id': row['id'],
                'report_date': report_date,
            },
        )


def downgrade() -> None:
    # Irreversible data backfill. Keep repaired report_date values.
    return
