"""backfill inventory report dates from file snapshot-date

Revision ID: 20260319_059
Revises: 20260318_058
Create Date: 2026-03-19 11:45:00.000000
"""

from __future__ import annotations

import csv
from datetime import date, datetime
from pathlib import Path
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260319_059'
down_revision: Union[str, None] = '20260318_058'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _parse_snapshot_date(value: str | None) -> date | None:
    text = (value or '').strip()
    if not text:
        return None
    for parser in (date.fromisoformat, lambda item: datetime.fromisoformat(item).date()):
        try:
            return parser(text)
        except ValueError:
            continue
    return None


def _read_inventory_snapshot_date(path: str | None) -> date | None:
    file_path = Path(str(path or '').strip())
    if not file_path.exists() or not file_path.is_file():
        return None

    with file_path.open('r', encoding='utf-8-sig', newline='') as handle:
        reader = csv.DictReader(handle, delimiter='\t')
        if not reader.fieldnames:
            return None
        snapshot_column = next((field for field in reader.fieldnames if str(field).strip() == 'snapshot-date'), None)
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
    if not inspector.has_table('analysis_source_files'):
        return

    columns = {column['name'] for column in inspector.get_columns('analysis_source_files')}
    required_columns = {'id', 'report_type', 'report_date', 'upload_file_path', 'snapshot_at'}
    if not required_columns.issubset(columns):
        return

    rows = bind.execute(
        sa.text(
            """
            select id, upload_file_path, snapshot_at
            from analysis_source_files
            where report_type = 'inventory_report'
              and report_date is null
            order by id asc
            """
        )
    ).mappings().all()

    for row in rows:
        snapshot_date = _read_inventory_snapshot_date(row.get('upload_file_path'))
        if snapshot_date is None and row.get('snapshot_at') is not None:
            snapshot_at = row['snapshot_at']
            if isinstance(snapshot_at, datetime):
                snapshot_date = snapshot_at.date()
        if snapshot_date is None:
            continue
        bind.execute(
            sa.text(
                """
                update analysis_source_files
                set report_date = :report_date,
                    updated_at = CURRENT_TIMESTAMP
                where id = :id
                """
            ),
            {
                'id': row['id'],
                'report_date': snapshot_date,
            },
        )


def downgrade() -> None:
    # Irreversible data backfill. Keep migrated report_date values.
    return
