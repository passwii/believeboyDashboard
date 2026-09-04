"""create ad upload files

Revision ID: 20260326_072
Revises: 20260326_071
Create Date: 2026-03-26 16:20:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260326_072'
down_revision: Union[str, None] = '20260326_071'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'ad_upload_files',
        sa.Column('id', sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column('project_id', sa.BigInteger(), sa.ForeignKey('projects.id', ondelete='CASCADE'), nullable=False),
        sa.Column('project_name', sa.String(length=255), nullable=False),
        sa.Column('report_type', sa.String(length=64), nullable=False),
        sa.Column('report_label', sa.String(length=255), nullable=False),
        sa.Column('country', sa.String(length=2), nullable=False, server_default='US'),
        sa.Column('report_date', sa.Date(), nullable=True),
        sa.Column('period_start_date', sa.Date(), nullable=False),
        sa.Column('period_end_date', sa.Date(), nullable=False),
        sa.Column('version', sa.Integer(), nullable=False, server_default='1'),
        sa.Column('is_current', sa.Boolean(), nullable=False, server_default=sa.text('true')),
        sa.Column('superseded_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('upload_file_id', sa.String(length=255), nullable=False),
        sa.Column('upload_file_path', sa.String(length=1024), nullable=False),
        sa.Column('original_filename', sa.String(length=255), nullable=True),
        sa.Column('stored_filename', sa.String(length=255), nullable=False),
        sa.Column('logical_filename', sa.String(length=255), nullable=False),
        sa.Column('file_extension', sa.String(length=16), nullable=False),
        sa.Column('file_size_bytes', sa.BigInteger(), nullable=True),
        sa.Column('recognition_status', sa.String(length=16), nullable=False, server_default='recognized'),
        sa.Column('ingestion_status', sa.String(length=16), nullable=False, server_default='pending'),
        sa.Column('ingestion_error', sa.Text(), nullable=True),
        sa.Column('row_count_preview', sa.Integer(), nullable=True),
        sa.Column('matched_columns', sa.JSON(), nullable=False),
        sa.Column('warnings', sa.JSON(), nullable=False),
        sa.Column('recognition_payload', sa.JSON(), nullable=False),
        sa.Column('created_by', sa.String(length=255), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('now()')),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('now()')),
        sa.UniqueConstraint(
            'project_id',
            'report_type',
            'country',
            'period_start_date',
            'period_end_date',
            'version',
            name='ad_upload_files_scope_version_key',
        ),
        sa.CheckConstraint(
            (
                "report_type in ("
                "'ad_time_trend_report', "
                "'ad_campaign_report', "
                "'ad_budget_report', "
                "'ad_placement_report', "
                "'ad_invalid_traffic_report', "
                "'ad_search_term_report', "
                "'ad_target_report', "
                "'ad_search_term_share_report', "
                "'ad_promoted_product_report', "
                "'ad_purchased_product_report'"
                ")"
            ),
            name='ck_ad_upload_files_report_type',
        ),
        sa.CheckConstraint(
            "recognition_status in ('recognized', 'unsupported', 'error')",
            name='ck_ad_upload_files_recognition_status',
        ),
        sa.CheckConstraint(
            "ingestion_status in ('pending', 'saved', 'failed')",
            name='ck_ad_upload_files_ingestion_status',
        ),
        sa.CheckConstraint('version >= 1', name='ck_ad_upload_files_version_positive'),
        sa.CheckConstraint('period_start_date <= period_end_date', name='ck_ad_upload_files_period_valid'),
    )
    op.create_index('idx_ad_upload_files_project_id', 'ad_upload_files', ['project_id'])
    op.create_index('idx_ad_upload_files_report_type', 'ad_upload_files', ['report_type'])
    op.create_index('idx_ad_upload_files_country', 'ad_upload_files', ['country'])
    op.create_index('idx_ad_upload_files_report_date', 'ad_upload_files', ['report_date'])
    op.create_index('idx_ad_upload_files_is_current', 'ad_upload_files', ['is_current'])
    op.create_index('idx_ad_upload_files_updated_at', 'ad_upload_files', ['updated_at'])
    op.create_index(
        'idx_ad_upload_files_project_scope',
        'ad_upload_files',
        ['project_id', 'report_type', 'country', 'period_start_date', 'period_end_date'],
    )


def downgrade() -> None:
    op.drop_index('idx_ad_upload_files_project_scope', table_name='ad_upload_files')
    op.drop_index('idx_ad_upload_files_updated_at', table_name='ad_upload_files')
    op.drop_index('idx_ad_upload_files_is_current', table_name='ad_upload_files')
    op.drop_index('idx_ad_upload_files_report_date', table_name='ad_upload_files')
    op.drop_index('idx_ad_upload_files_country', table_name='ad_upload_files')
    op.drop_index('idx_ad_upload_files_report_type', table_name='ad_upload_files')
    op.drop_index('idx_ad_upload_files_project_id', table_name='ad_upload_files')
    op.drop_table('ad_upload_files')
