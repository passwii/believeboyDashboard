"""backfill inventory snapshot_at from report_date (business date)

Revision ID: 20260420_098
Revises: 20260419_097
Create Date: 2026-04-20 00:00:00.000000
"""

from __future__ import annotations

from datetime import datetime
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260420_098'
down_revision: Union[str, None] = '20260419_097'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Set snapshot_at = report_date at 00:00:00 (naive, no timezone) for all inventory_report rows.

    Business dates have no inherent timezone — they represent the local date in the
    relevant country's timezone. snapshot_at is stored as a naive datetime so that the
    frontend can display it without any timezone conversion.

    NOTE: the column is TIMESTAMP WITH TIME ZONE in PostgreSQL. We use a raw SQL
    UPDATE with inline date construction to avoid Python bind-parameter type mismatches
    between Python date objects and PostgreSQL date columns.
    """
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table('analysis_source_files'):
        return

    columns = {column['name'] for column in inspector.get_columns('analysis_source_files')}
    required_columns = {'id', 'report_type', 'report_date', 'snapshot_at'}
    if not required_columns.issubset(columns):
        return

    # Use a single UPDATE with inline CAST so PostgreSQL handles the date→timestamp
    # conversion without any Python bind-parameter type ambiguity.
    result = bind.execute(
        sa.text(
            """
            UPDATE analysis_source_files
            SET snapshot_at = (
                (report_date::text || ' 00:00:00')::timestamp without time zone
              ),
                updated_at = CURRENT_TIMESTAMP
            WHERE report_type = 'inventory_report'
              AND report_date IS NOT NULL
            """
        )
    )
    updated = result.rowcount if result.rowcount is not None else 0
    print(f"[20260420_098] Updated {updated} inventory_report rows with naive snapshot_at from report_date.")


def downgrade() -> None:
    return
