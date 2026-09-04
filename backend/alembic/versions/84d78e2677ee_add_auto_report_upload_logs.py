"""add auto_report_upload_logs

Revision ID: 84d78e2677ee
Revises: 20260629_201
Create Date: 2026-06-30 07:18:30.632174
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '84d78e2677ee'
down_revision: Union[str, None] = '20260629_201'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('auto_report_upload_logs',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('run_id', sa.String(length=32), nullable=False,
                  comment='run batch id, e.g. auto-20260630_153000'),
        sa.Column('created_at', sa.DateTime(timezone=True),
                  server_default=sa.text('now()'), nullable=False,
                  comment='when this log row was written'),
        sa.Column('status', sa.String(length=10), nullable=False,
                  comment='success | skipped | failed'),
        sa.Column('country', sa.String(length=10), nullable=False),
        sa.Column('project_name', sa.String(length=100), nullable=False),
        sa.Column('report_type_label', sa.String(length=100), nullable=False,
                  comment='Chinese label e.g. 搜索词展示量份额'),
        sa.Column('report_date_display', sa.String(length=20), nullable=True,
                  comment='Compressed date display e.g. 06-25 / 06-25~06-28'),
        sa.Column('report_type', sa.String(length=64), nullable=True,
                  comment='English report_type key for filtering, e.g. ad_search_term_report'),
        sa.Column('original_filename', sa.String(length=256), nullable=True),
        sa.Column('source_id', sa.Integer(), nullable=True,
                  comment='Primary key of the ingested row'),
        sa.Column('source_table', sa.String(length=4), nullable=True,
                  comment='A = analysis_source_files, C = ad_upload_files'),
        sa.Column('row_count', sa.Integer(), nullable=False, server_default='0',
                  comment='Number of rows persisted (meaningful when status=success)'),
        sa.Column('detected_start_date', sa.String(length=20), nullable=True,
                  comment='Full start date YYYY-MM-DD'),
        sa.Column('detected_end_date', sa.String(length=20), nullable=True,
                  comment='Full end date YYYY-MM-DD'),
        sa.Column('duration_seconds', sa.Float(), nullable=True,
                  comment='Total processing wall-clock time in seconds'),
        sa.Column('error_message', sa.Text(), nullable=True,
                  comment='Full error trace or skip reason (untruncated)'),
        sa.Column('note', sa.String(length=500), nullable=True,
                  comment="Free-form note for things that can't be structured"),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('idx_aru_logs_created_at', 'auto_report_upload_logs', ['created_at'], unique=False)
    op.create_index('idx_aru_logs_run_id', 'auto_report_upload_logs', ['run_id'], unique=False)
    op.create_index('idx_aru_logs_status', 'auto_report_upload_logs', ['status'], unique=False)
    op.create_index('idx_aru_logs_project_status', 'auto_report_upload_logs', ['project_name', 'status'], unique=False)


def downgrade() -> None:
    op.drop_index('idx_aru_logs_project_status', table_name='auto_report_upload_logs')
    op.drop_index('idx_aru_logs_status', table_name='auto_report_upload_logs')
    op.drop_index('idx_aru_logs_run_id', table_name='auto_report_upload_logs')
    op.drop_index('idx_aru_logs_created_at', table_name='auto_report_upload_logs')
    op.drop_table('auto_report_upload_logs')
