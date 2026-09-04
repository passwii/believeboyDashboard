"""backfill missing daily ad product sources from local export

Revision ID: 20260320_066
Revises: 20260320_065
Create Date: 2026-03-20 15:10:00.000000
"""

from __future__ import annotations

from datetime import date, datetime
import json
from pathlib import Path
from typing import Any, Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260320_066'
down_revision: Union[str, None] = '20260320_065'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


DATA_FILE = Path(__file__).resolve().parent / 'data' / '20260320_066_missing_daily_ad_reports.json'


def _parse_date(value: str | None) -> date | None:
    text = str(value or '').strip()
    if not text:
        return None
    return date.fromisoformat(text)


def _parse_datetime(value: str | None) -> datetime | None:
    text = str(value or '').strip()
    if not text:
        return None
    return datetime.fromisoformat(text)


def _load_records() -> list[dict[str, Any]]:
    if not DATA_FILE.exists():
        raise RuntimeError(f'Missing backfill data file: {DATA_FILE}')

    payload = json.loads(DATA_FILE.read_text(encoding='utf-8'))
    records = payload.get('records')
    if not isinstance(records, list):
        raise RuntimeError(f'Invalid backfill data payload: {DATA_FILE}')
    return records


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    required_tables = {'projects', 'analysis_source_files', 'analysis_ad_product_rows'}
    if not required_tables.issubset(set(inspector.get_table_names())):
        return

    source_columns = {column['name'] for column in inspector.get_columns('analysis_source_files')}
    required_source_columns = {
        'id',
        'project_id',
        'report_type',
        'country',
        'report_date',
        'period_start_date',
        'period_end_date',
        'snapshot_at',
        'version',
        'is_current',
        'superseded_at',
        'upload_file_id',
        'upload_file_path',
        'original_filename',
        'stored_filename',
        'logical_filename',
        'storage_key',
        'file_size_bytes',
        'file_sha256',
        'ingestion_status',
        'ingestion_error',
        'row_count_total',
        'row_count_included',
        'created_by',
        'created_at',
        'updated_at',
    }
    if not required_source_columns.issubset(source_columns):
        return

    ad_columns = {column['name'] for column in inspector.get_columns('analysis_ad_product_rows')}
    required_ad_columns = {
        'source_file_id',
        'source_row_no',
        'sku',
        'asin',
        'impressions',
        'clicks',
        'spend',
        'sales_7d',
        'orders_7d',
        'scope_status',
        'scope_reason',
        'raw_row',
        'created_at',
    }
    if not required_ad_columns.issubset(ad_columns):
        return

    records = _load_records()
    if not records:
        return

    project_names = sorted(
        {
            str(record.get('project_name') or '').strip()
            for record in records
            if str(record.get('project_name') or '').strip()
        }
    )
    project_rows = bind.execute(
        sa.text(
            """
            select id, project_name
            from projects
            where project_name in :project_names
            """
        ).bindparams(sa.bindparam('project_names', expanding=True)),
        {'project_names': project_names},
    ).mappings()
    project_id_by_name = {str(row['project_name']): int(row['id']) for row in project_rows}

    source_insert = sa.text(
        """
        insert into analysis_source_files (
            project_id,
            report_type,
            country,
            report_date,
            period_start_date,
            period_end_date,
            snapshot_at,
            version,
            is_current,
            superseded_at,
            upload_file_id,
            upload_file_path,
            original_filename,
            stored_filename,
            logical_filename,
            storage_key,
            file_size_bytes,
            file_sha256,
            ingestion_status,
            ingestion_error,
            row_count_total,
            row_count_included,
            created_by,
            created_at,
            updated_at
        )
        values (
            :project_id,
            :report_type,
            :country,
            :report_date,
            :period_start_date,
            :period_end_date,
            :snapshot_at,
            :version,
            :is_current,
            :superseded_at,
            :upload_file_id,
            :upload_file_path,
            :original_filename,
            :stored_filename,
            :logical_filename,
            :storage_key,
            :file_size_bytes,
            :file_sha256,
            :ingestion_status,
            :ingestion_error,
            :row_count_total,
            :row_count_included,
            :created_by,
            :created_at,
            :updated_at
        )
        returning id
        """
    )
    ad_insert = sa.text(
        """
        insert into analysis_ad_product_rows (
            source_file_id,
            source_row_no,
            sku,
            asin,
            impressions,
            clicks,
            spend,
            sales_7d,
            orders_7d,
            scope_status,
            scope_reason,
            raw_row,
            created_at
        )
        values (
            :source_file_id,
            :source_row_no,
            :sku,
            :asin,
            :impressions,
            :clicks,
            :spend,
            :sales_7d,
            :orders_7d,
            :scope_status,
            :scope_reason,
            :raw_row,
            :created_at
        )
        """
    )

    for record in records:
        project_name = str(record.get('project_name') or '').strip()
        country = str(record.get('country') or 'US').strip() or 'US'
        source = record.get('source') if isinstance(record.get('source'), dict) else {}
        report_date = _parse_date(source.get('report_date'))
        period_start_date = _parse_date(source.get('period_start_date'))
        period_end_date = _parse_date(source.get('period_end_date'))

        if project_name not in project_id_by_name:
            continue
        if report_date is None or period_start_date is None or period_end_date is None:
            continue
        if report_date != period_start_date or report_date != period_end_date:
            continue

        existing_source_id = bind.execute(
            sa.text(
                """
                select id
                from analysis_source_files
                where project_id = :project_id
                  and report_type = 'ad_product_report'
                  and country = :country
                  and report_date = :report_date
                  and period_start_date = :period_start_date
                  and period_end_date = :period_end_date
                limit 1
                """
            ),
            {
                'project_id': project_id_by_name[project_name],
                'country': country,
                'report_date': report_date,
                'period_start_date': period_start_date,
                'period_end_date': period_end_date,
            },
        ).scalar()
        if existing_source_id is not None:
            continue

        inserted_source_id = bind.execute(
            source_insert,
            {
                'project_id': project_id_by_name[project_name],
                'report_type': 'ad_product_report',
                'country': country,
                'report_date': report_date,
                'period_start_date': period_start_date,
                'period_end_date': period_end_date,
                'snapshot_at': _parse_datetime(source.get('snapshot_at')),
                'version': int(source.get('version') or 1),
                'is_current': bool(source.get('is_current')),
                'superseded_at': _parse_datetime(source.get('superseded_at')),
                'upload_file_id': source.get('upload_file_id'),
                'upload_file_path': source.get('upload_file_path'),
                'original_filename': source.get('original_filename'),
                'stored_filename': source.get('stored_filename'),
                'logical_filename': source.get('logical_filename'),
                'storage_key': source.get('storage_key'),
                'file_size_bytes': source.get('file_size_bytes'),
                'file_sha256': source.get('file_sha256'),
                'ingestion_status': source.get('ingestion_status'),
                'ingestion_error': source.get('ingestion_error'),
                'row_count_total': int(source.get('row_count_total') or 0),
                'row_count_included': int(source.get('row_count_included') or 0),
                'created_by': source.get('created_by'),
                'created_at': _parse_datetime(source.get('created_at')),
                'updated_at': _parse_datetime(source.get('updated_at')),
            },
        ).scalar_one()

        ad_rows = record.get('ad_rows') if isinstance(record.get('ad_rows'), list) else []
        if not ad_rows:
            continue

        bind.execute(
            ad_insert,
            [
                {
                    'source_file_id': int(inserted_source_id),
                    'source_row_no': int(row.get('source_row_no') or 0),
                    'sku': row.get('sku'),
                    'asin': row.get('asin'),
                    'impressions': int(row.get('impressions') or 0),
                    'clicks': int(row.get('clicks') or 0),
                    'spend': row.get('spend'),
                    'sales_7d': row.get('sales_7d'),
                    'orders_7d': int(row.get('orders_7d') or 0),
                    'scope_status': row.get('scope_status'),
                    'scope_reason': row.get('scope_reason'),
                    'raw_row': json.dumps(row.get('raw_row') or {}, ensure_ascii=False),
                    'created_at': _parse_datetime(row.get('created_at')),
                }
                for row in ad_rows
            ],
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not {'projects', 'analysis_source_files'}.issubset(set(inspector.get_table_names())):
        return

    records = _load_records()
    if not records:
        return

    keys = []
    for record in records:
        project_name = str(record.get('project_name') or '').strip()
        country = str(record.get('country') or 'US').strip() or 'US'
        source = record.get('source') if isinstance(record.get('source'), dict) else {}
        report_date = str(source.get('report_date') or '').strip()
        if not project_name or not report_date:
            continue
        keys.append((project_name, country, report_date))

    if not keys:
        return

    delete_conditions = []
    params: dict[str, Any] = {}
    for index, (project_name, country, report_date) in enumerate(keys):
        delete_conditions.append(
            f"(p.project_name = :project_name_{index} and s.country = :country_{index} and s.report_date = :report_date_{index})"
        )
        params[f'project_name_{index}'] = project_name
        params[f'country_{index}'] = country
        params[f'report_date_{index}'] = report_date

    bind.execute(
        sa.text(
            f"""
            delete from analysis_source_files s
            using projects p
            where p.id = s.project_id
              and s.report_type = 'ad_product_report'
              and s.period_start_date = s.report_date
              and s.period_end_date = s.report_date
              and ({' or '.join(delete_conditions)})
            """
        ),
        params,
    )
