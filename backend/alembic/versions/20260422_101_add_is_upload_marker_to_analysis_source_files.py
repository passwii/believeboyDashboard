"""add is_upload_marker to analysis_source_files

Revision ID: 20260422_101
Revises: 20260422_100
Create Date: 2026-04-22 00:00:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260422_101'
down_revision: Union[str, None] = '20260422_100'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'analysis_source_files',
        sa.Column('is_upload_marker', sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.create_index(
        'idx_analysis_sources_upload_marker',
        'analysis_source_files',
        ['project_id', 'report_type', 'country', 'report_date', 'is_upload_marker'],
    )


def downgrade() -> None:
    op.drop_index('idx_analysis_sources_upload_marker', table_name='analysis_source_files')
    op.drop_column('analysis_source_files', 'is_upload_marker')