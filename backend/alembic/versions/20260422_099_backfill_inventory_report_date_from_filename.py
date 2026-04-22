"""backfill inventory report_date from snapshot-date in inventory rows

Revision ID: 20260422_099
Revises: 20260421_002
Create Date: 2026-04-22 00:00:00.000000
"""

from __future__ import annotations

from datetime import datetime
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260422_099'
down_revision: Union[str, None] = '20260421_002'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Fill report_date for auto-uploaded inventory_report records.

    The auto-upload script (autoReportUpload) did not extract report_date from the
    file's snapshot-date column.  All NULL report_date records have their first
    inventory_snapshot row's raw_row->'snapshot-date' which contains the real
    business date (e.g. "2026-04-20").

    Step 1: Extract snapshot-date from raw_row JSONB for NULL report_date records.
            Uses LATERAL join in a SELECT to find matching records, then batch UPDATE.
    Step 2: Fall back to snapshot_at::date for any rows still NULL (edge case).
    Step 3: Clear all is_current flags for inventory_report.
    Step 4: Activate latest record per project/country/report_date as is_current=TRUE.
    """
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table('analysis_source_files'):
        return

    columns = {col['name'] for col in inspector.get_columns('analysis_source_files')}
    required = {'id', 'report_type', 'report_date', 'snapshot_at', 'original_filename'}
    if not required.issubset(columns):
        return

    has_snapshot_rows = inspector.has_table('inventory_snapshot_rows')

    if has_snapshot_rows:
        # Find NULL report_date records whose inventory rows have a snapshot-date.
        # LATERAL join lets us look up the first matching row per source_file.
        target_rows = bind.execute(
            sa.text(
                """
                SELECT f.id AS file_id,
                       (sr.raw_row ->> 'snapshot-date')::date AS snap_date
                FROM analysis_source_files f
                JOIN LATERAL (
                    SELECT id, raw_row
                    FROM inventory_snapshot_rows
                    WHERE source_file_id = f.id
                      AND (raw_row ->> 'snapshot-date') IS NOT NULL
                    LIMIT 1
                ) sr ON TRUE
                WHERE f.report_type = 'inventory_report'
                  AND f.report_date IS NULL
                """
            )
        ).fetchall()

        if target_rows:
            file_ids = [r.file_id for r in target_rows]
            bind.execute(
                sa.text(
                    """
                    UPDATE analysis_source_files
                    SET report_date = sd.snap_date,
                        updated_at = :now
                    FROM (
                        SELECT f.id AS file_id,
                               (sr.raw_row ->> 'snapshot-date')::date AS snap_date
                        FROM analysis_source_files f
                        JOIN LATERAL (
                            SELECT id, raw_row
                            FROM inventory_snapshot_rows
                            WHERE source_file_id = f.id
                              AND (raw_row ->> 'snapshot-date') IS NOT NULL
                            LIMIT 1
                        ) sr ON TRUE
                        WHERE f.report_type = 'inventory_report'
                          AND f.report_date IS NULL
                          AND f.id = ANY(:file_ids)
                    ) sd
                    WHERE analysis_source_files.id = sd.file_id
                    """
                ),
                {"now": datetime.utcnow(), "file_ids": file_ids},
            )
            from_raw_row = len(target_rows)
            print(f"[20260422_099] From raw_row->snapshot-date: {from_raw_row} rows")
        else:
            from_raw_row = 0
            print("[20260422_099] No NULL report_date records with matching inventory rows")
    else:
        from_raw_row = 0
        print("[20260422_099] inventory_snapshot_rows not found, skipping step 1")

    # Step 2: Fallback — use snapshot_at date for any remaining NULL rows
    result2 = bind.execute(
        sa.text(
            """
            UPDATE analysis_source_files
            SET report_date = snapshot_at::date,
                updated_at = CURRENT_TIMESTAMP
            WHERE report_type = 'inventory_report'
              AND report_date IS NULL
              AND snapshot_at IS NOT NULL
            """
        )
    )
    from_snapshot_at = result2.rowcount if result2.rowcount is not None else 0
    print(f"[20260422_099] From snapshot_at fallback: {from_snapshot_at} rows")

    total_fixed = from_raw_row + from_snapshot_at
    print(f"[20260422_099] Total report_date fixed: {total_fixed} rows")

    # Step 3: Clear all is_current flags (partial unique index permits 0 TRUE rows)
    result3 = bind.execute(
        sa.text(
            """
            UPDATE analysis_source_files
            SET is_current = FALSE,
                superseded_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE report_type = 'inventory_report'
              AND is_current = TRUE
            """
        )
    )
    cleared = result3.rowcount if result3.rowcount is not None else 0
    print(f"[20260422_099] Cleared is_current: {cleared} rows")

    # Step 4: Activate latest record per project/country.
    # Group by (project_id, country) — NOT (project_id, country, report_date) —
    # because the data contains many duplicate (project_id, country, report_date)
    # groups (historical bug: multiple uploads per day, is_current never updated).
    # The unique partial index only allows one is_current=TRUE per project/country.
    result4 = bind.execute(
        sa.text(
            """
            UPDATE analysis_source_files
            SET is_current = TRUE,
                superseded_at = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE id IN (
                SELECT MAX(id)
                FROM analysis_source_files
                WHERE report_type = 'inventory_report'
                  AND report_date IS NOT NULL
                GROUP BY project_id, country
            )
            """
        )
    )
    activated = result4.rowcount if result4.rowcount is not None else 0
    print(f"[20260422_099] Activated is_current: {activated} rows")

    print("[20260422_099] Done.")


def downgrade() -> None:
    return
