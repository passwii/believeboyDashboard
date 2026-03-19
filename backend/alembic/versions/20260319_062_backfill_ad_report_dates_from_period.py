"""backfill ad report dates from single-day period

Revision ID: 20260319_062
Revises: 20260319_061
Create Date: 2026-03-19 17:05:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260319_062'
down_revision: Union[str, None] = '20260319_061'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table('analysis_source_files'):
        return

    columns = {column['name'] for column in inspector.get_columns('analysis_source_files')}
    required_columns = {
        'report_type',
        'report_date',
        'period_start_date',
        'period_end_date',
        'updated_at',
    }
    if not required_columns.issubset(columns):
        return

    bind.execute(
        sa.text(
            """
            update analysis_source_files
            set report_date = period_start_date,
                updated_at = CURRENT_TIMESTAMP
            where report_type = 'ad_product_report'
              and report_date is null
              and period_start_date is not null
              and period_end_date is not null
              and period_start_date = period_end_date
            """
        )
    )


def downgrade() -> None:
    # Irreversible data backfill. Keep repaired report_date values.
    return
