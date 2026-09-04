"""move daily sales into analysis sources

Revision ID: 20260318_057
Revises: 20260318_056
Create Date: 2026-03-18 21:55:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260318_057'
down_revision: Union[str, None] = '20260318_056'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


SALES_REPORT_TYPE = 'sales_report'


def _fetchall_dicts(conn, sql: str, **params) -> list[dict]:
    return [dict(row) for row in conn.execute(sa.text(sql), params).mappings().all()]


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    required_tables = {'analysis_source_files', 'analysis_sales_order_rows', 'daily_source_files', 'daily_sales_order'}
    if not required_tables.issubset(set(inspector.get_table_names())):
        return

    daily_sources = _fetchall_dicts(
        conn,
        """
        select
            id,
            project_id,
            report_type,
            country,
            report_date,
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
        from daily_source_files
        where report_type = :report_type
        order by id asc
        """,
        report_type=SALES_REPORT_TYPE,
    )

    source_id_map: dict[int, int] = {}
    for row in daily_sources:
        existing = conn.execute(
            sa.text(
                """
                select id, report_date
                from analysis_source_files
                where project_id = :project_id
                  and report_type = :report_type
                  and country = :country
                  and period_start_date = :report_date
                  and period_end_date = :report_date
                  and version = :version
                order by id asc
                limit 1
                """
            ),
            {
                'project_id': row['project_id'],
                'report_type': SALES_REPORT_TYPE,
                'country': row['country'],
                'report_date': row['report_date'],
                'version': row['version'],
            },
        ).mappings().first()

        if existing is None:
            inserted_id = conn.execute(
                sa.text(
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
                    ) values (
                        :project_id,
                        :report_type,
                        :country,
                        :report_date,
                        :report_date,
                        :report_date,
                        null,
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
                ),
                {
                    'project_id': row['project_id'],
                    'report_type': SALES_REPORT_TYPE,
                    'country': row['country'],
                    'report_date': row['report_date'],
                    'version': row['version'],
                    'is_current': row['is_current'],
                    'superseded_at': row['superseded_at'],
                    'upload_file_id': row['upload_file_id'],
                    'upload_file_path': row['upload_file_path'],
                    'original_filename': row['original_filename'],
                    'stored_filename': row['stored_filename'],
                    'logical_filename': row['logical_filename'],
                    'storage_key': row['storage_key'],
                    'file_size_bytes': row['file_size_bytes'],
                    'file_sha256': row['file_sha256'],
                    'ingestion_status': row['ingestion_status'],
                    'ingestion_error': row['ingestion_error'],
                    'row_count_total': row['row_count_total'],
                    'row_count_included': row['row_count_included'],
                    'created_by': row['created_by'],
                    'created_at': row['created_at'],
                    'updated_at': row['updated_at'],
                },
            ).scalar_one()
            analysis_source_id = int(inserted_id)
        else:
            analysis_source_id = int(existing['id'])
            if existing.get('report_date') is None:
                conn.execute(
                    sa.text('update analysis_source_files set report_date = :report_date where id = :id'),
                    {'id': analysis_source_id, 'report_date': row['report_date']},
                )

        source_id_map[int(row['id'])] = analysis_source_id

    for daily_source_id, analysis_source_id in source_id_map.items():
        existing_row_count = conn.execute(
            sa.text('select count(*) from analysis_sales_order_rows where source_file_id = :source_file_id'),
            {'source_file_id': analysis_source_id},
        ).scalar_one()
        if int(existing_row_count or 0) == 0:
            conn.execute(
                sa.text(
                    """
                    insert into analysis_sales_order_rows (
                        source_file_id,
                        source_row_no,
                        amazon_order_id,
                        purchase_at_utc,
                        purchase_at_pt,
                        purchase_date_pt,
                        order_status,
                        sku,
                        asin,
                        quantity,
                        item_price,
                        currency,
                        is_counted_sales,
                        status_rule_version,
                        raw_row,
                        created_at
                    )
                    select
                        :analysis_source_id,
                        source_row_no,
                        amazon_order_id,
                        purchase_at_utc,
                        purchase_at_pt,
                        purchase_date_pt,
                        order_status,
                        sku,
                        asin,
                        quantity,
                        item_price,
                        currency,
                        is_counted_sales,
                        status_rule_version,
                        raw_row,
                        created_at
                    from daily_sales_order
                    where source_file_id = :daily_source_id
                    order by source_row_no asc
                    """
                ),
                {
                    'analysis_source_id': analysis_source_id,
                    'daily_source_id': daily_source_id,
                },
            )

    if source_id_map:
        conn.execute(
            sa.text(
                """
                delete from daily_sales_order
                where source_file_id in (
                    select id from daily_source_files where report_type = :report_type
                )
                """
            ),
            {'report_type': SALES_REPORT_TYPE},
        )
        conn.execute(
            sa.text('delete from daily_source_files where report_type = :report_type'),
            {'report_type': SALES_REPORT_TYPE},
        )


def downgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    required_tables = {'analysis_source_files', 'analysis_sales_order_rows', 'daily_source_files', 'daily_sales_order'}
    if not required_tables.issubset(set(inspector.get_table_names())):
        return

    analysis_sources = _fetchall_dicts(
        conn,
        """
        select
            id,
            project_id,
            report_type,
            country,
            report_date,
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
        from analysis_source_files
        where report_type = :report_type
          and report_date is not null
          and period_start_date = report_date
          and period_end_date = report_date
        order by id asc
        """,
        report_type=SALES_REPORT_TYPE,
    )

    source_id_map: dict[int, int] = {}
    for row in analysis_sources:
        existing_id = conn.execute(
            sa.text(
                """
                select id
                from daily_source_files
                where project_id = :project_id
                  and report_type = :report_type
                  and country = :country
                  and report_date = :report_date
                  and version = :version
                order by id asc
                limit 1
                """
            ),
            {
                'project_id': row['project_id'],
                'report_type': SALES_REPORT_TYPE,
                'country': row['country'],
                'report_date': row['report_date'],
                'version': row['version'],
            },
        ).scalar()

        if existing_id is None:
            existing_id = conn.execute(
                sa.text(
                    """
                    insert into daily_source_files (
                        project_id,
                        report_type,
                        country,
                        report_date,
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
                    ) values (
                        :project_id,
                        :report_type,
                        :country,
                        :report_date,
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
                ),
                {
                    'project_id': row['project_id'],
                    'report_type': SALES_REPORT_TYPE,
                    'country': row['country'],
                    'report_date': row['report_date'],
                    'version': row['version'],
                    'is_current': row['is_current'],
                    'superseded_at': row['superseded_at'],
                    'upload_file_id': row['upload_file_id'],
                    'upload_file_path': row['upload_file_path'],
                    'original_filename': row['original_filename'],
                    'stored_filename': row['stored_filename'],
                    'logical_filename': row['logical_filename'],
                    'storage_key': row['storage_key'],
                    'file_size_bytes': row['file_size_bytes'],
                    'file_sha256': row['file_sha256'],
                    'ingestion_status': row['ingestion_status'],
                    'ingestion_error': row['ingestion_error'],
                    'row_count_total': row['row_count_total'],
                    'row_count_included': row['row_count_included'],
                    'created_by': row['created_by'],
                    'created_at': row['created_at'],
                    'updated_at': row['updated_at'],
                },
            ).scalar_one()

        source_id_map[int(row['id'])] = int(existing_id)

    for analysis_source_id, daily_source_id in source_id_map.items():
        existing_row_count = conn.execute(
            sa.text('select count(*) from daily_sales_order where source_file_id = :source_file_id'),
            {'source_file_id': daily_source_id},
        ).scalar_one()
        if int(existing_row_count or 0) == 0:
            conn.execute(
                sa.text(
                    """
                    insert into daily_sales_order (
                        source_file_id,
                        source_row_no,
                        amazon_order_id,
                        purchase_at_utc,
                        purchase_at_pt,
                        purchase_date_pt,
                        order_status,
                        sku,
                        asin,
                        quantity,
                        item_price,
                        currency,
                        is_counted_sales,
                        status_rule_version,
                        raw_row,
                        created_at
                    )
                    select
                        :daily_source_id,
                        source_row_no,
                        amazon_order_id,
                        purchase_at_utc,
                        purchase_at_pt,
                        purchase_date_pt,
                        order_status,
                        sku,
                        asin,
                        quantity,
                        item_price,
                        currency,
                        is_counted_sales,
                        status_rule_version,
                        raw_row,
                        created_at
                    from analysis_sales_order_rows
                    where source_file_id = :analysis_source_id
                    order by source_row_no asc
                    """
                ),
                {
                    'daily_source_id': daily_source_id,
                    'analysis_source_id': analysis_source_id,
                },
            )
