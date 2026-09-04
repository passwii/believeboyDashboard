"""delete pre-2026 payment report history

Revision ID: 20260319_064
Revises: 20260319_063
Create Date: 2026-03-19 18:40:00.000000
"""

from datetime import date
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260319_064'
down_revision: Union[str, None] = '20260319_063'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


CUTOFF_DATE = date(2026, 1, 1)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not inspector.has_table('analysis_source_files'):
        return

    columns = {column['name'] for column in inspector.get_columns('analysis_source_files')}
    required_columns = {'report_type', 'period_start_date', 'period_end_date'}
    if not required_columns.issubset(columns):
        return

    bind.execute(
        sa.text(
            """
            delete from analysis_source_files
            where report_type = 'payment_report'
              and (
                period_start_date < :cutoff_date
                or period_end_date < :cutoff_date
              )
            """
        ),
        {'cutoff_date': CUTOFF_DATE},
    )


def downgrade() -> None:
    # Irreversible data cleanup. Deleted historical rows are not restored.
    return
