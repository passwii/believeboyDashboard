"""add is_upload_marker to return_analysis_records

Revision ID: 20260422_100
Revises: 20260422_099
Create Date: 2026-04-22 00:00:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260422_100'
down_revision: Union[str, None] = '20260422_099'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add is_upload_marker boolean column to return_analysis_records.

    When a return report file is uploaded with no actual return records,
    persist_return_report creates a marker row (order_id='__MARKER__') with
    is_upload_marker=True. The RPA report status query filters these out so
    they don't count as having data, but the marker row ensures the date is
    recognised as having been processed.
    """
    op.add_column(
        'return_analysis_records',
        sa.Column('is_upload_marker', sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    # Index on (project_id, country, return_date) for efficient RPA status lookups
    op.create_index(
        'idx_return_upload_marker_lookup',
        'return_analysis_records',
        ['project_id', 'country', 'return_date', 'is_upload_marker'],
    )


def downgrade() -> None:
    op.drop_index('idx_return_upload_marker_lookup', table_name='return_analysis_records')
    op.drop_column('return_analysis_records', 'is_upload_marker')