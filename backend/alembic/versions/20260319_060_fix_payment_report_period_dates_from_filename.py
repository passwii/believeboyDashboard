"""fix payment report period dates from original filename

Revision ID: 20260319_060
Revises: 20260319_059
Create Date: 2026-03-19 15:10:00.000000
"""

from __future__ import annotations

from datetime import date
import re
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260319_060'
down_revision: Union[str, None] = '20260319_059'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_MONTH_MAP = {
    'jan': 1,
    'feb': 2,
    'mar': 3,
    'apr': 4,
    'may': 5,
    'jun': 6,
    'jul': 7,
    'aug': 8,
    'sep': 9,
    'oct': 10,
    'nov': 11,
    'dec': 12,
}

_PAYMENT_FILENAME_RE = re.compile(
    r'(?i)(\d{4})(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)(\d{1,2})'
    r'\s*-\s*'
    r'(\d{4})(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)(\d{1,2})'
    r'customtransaction'
)


def _build_date(year_text: str, month_text: str, day_text: str) -> date | None:
    month = _MONTH_MAP.get(str(month_text).strip().lower())
    if month is None:
        return None
    try:
        return date(int(year_text), month, int(day_text))
    except ValueError:
        return None


def _parse_payment_period_from_filename(value: str | None) -> tuple[date, date] | None:
    text = str(value or '').strip()
    if not text:
        return None

    match = _PAYMENT_FILENAME_RE.search(text)
    if match is None:
        return None

    start_date = _build_date(match.group(1), match.group(2), match.group(3))
    end_date = _build_date(match.group(4), match.group(5), match.group(6))
    if start_date is None or end_date is None:
        return None
    if start_date > end_date:
        return None
    return start_date, end_date


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table('analysis_source_files'):
        return

    columns = {column['name'] for column in inspector.get_columns('analysis_source_files')}
    required_columns = {
        'id',
        'project_id',
        'report_type',
        'country',
        'version',
        'is_current',
        'period_start_date',
        'period_end_date',
        'original_filename',
        'stored_filename',
        'upload_file_id',
        'superseded_at',
    }
    if not required_columns.issubset(columns):
        return

    rows = bind.execute(
        sa.text(
            """
            select id,
                   project_id,
                   country,
                   version,
                   is_current,
                   original_filename,
                   stored_filename,
                   upload_file_id,
                   period_start_date,
                   period_end_date,
                   superseded_at
            from analysis_source_files
            where report_type = 'payment_report'
            order by id asc
            """
        )
    ).mappings().all()

    for row in rows:
        parsed_period = (
            _parse_payment_period_from_filename(row.get('original_filename'))
            or _parse_payment_period_from_filename(row.get('stored_filename'))
            or _parse_payment_period_from_filename(row.get('upload_file_id'))
        )
        if parsed_period is None:
            continue

        parsed_start_date, parsed_end_date = parsed_period
        if (
            row.get('period_start_date') == parsed_start_date
            and row.get('period_end_date') == parsed_end_date
        ):
            continue

        next_version = int(row.get('version') or 1)
        if bind.execute(
            sa.text(
                """
                select 1
                from analysis_source_files
                where project_id = :project_id
                  and report_type = 'payment_report'
                  and country = :country
                  and period_start_date = :period_start_date
                  and period_end_date = :period_end_date
                  and version = :version
                  and id <> :id
                limit 1
                """
            ),
            {
                'id': row['id'],
                'project_id': row['project_id'],
                'country': row['country'],
                'period_start_date': parsed_start_date,
                'period_end_date': parsed_end_date,
                'version': next_version,
            },
        ).scalar() is not None:
            max_version = bind.execute(
                sa.text(
                    """
                    select coalesce(max(version), 0)
                    from analysis_source_files
                    where project_id = :project_id
                      and report_type = 'payment_report'
                      and country = :country
                      and period_start_date = :period_start_date
                      and period_end_date = :period_end_date
                      and id <> :id
                    """
                ),
                {
                    'id': row['id'],
                    'project_id': row['project_id'],
                    'country': row['country'],
                    'period_start_date': parsed_start_date,
                    'period_end_date': parsed_end_date,
                },
            ).scalar()
            next_version = int(max_version or 0) + 1

        next_is_current = bool(row.get('is_current'))
        if next_is_current and bind.execute(
            sa.text(
                """
                select 1
                from analysis_source_files
                where project_id = :project_id
                  and report_type = 'payment_report'
                  and country = :country
                  and period_start_date = :period_start_date
                  and period_end_date = :period_end_date
                  and is_current is true
                  and id <> :id
                limit 1
                """
            ),
            {
                'id': row['id'],
                'project_id': row['project_id'],
                'country': row['country'],
                'period_start_date': parsed_start_date,
                'period_end_date': parsed_end_date,
            },
        ).scalar() is not None:
            next_is_current = False

        bind.execute(
            sa.text(
                """
                update analysis_source_files
                set period_start_date = :period_start_date,
                    period_end_date = :period_end_date,
                    version = :version,
                    is_current = :is_current,
                    superseded_at = case
                        when :is_current = false and superseded_at is null then CURRENT_TIMESTAMP
                        else superseded_at
                    end,
                    updated_at = CURRENT_TIMESTAMP
                where id = :id
                """
            ),
            {
                'id': row['id'],
                'period_start_date': parsed_start_date,
                'period_end_date': parsed_end_date,
                'version': next_version,
                'is_current': next_is_current,
            },
        )


def downgrade() -> None:
    # Irreversible data repair. Keep corrected payment report periods.
    return
