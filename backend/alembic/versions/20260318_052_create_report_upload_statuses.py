"""create report upload statuses table

Revision ID: 20260318_052
Revises: 20260318_051
Create Date: 2026-03-18 12:30:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260318_052'
down_revision: Union[str, None] = '20260318_051'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing_tables = set(inspector.get_table_names())
    if 'report_upload_statuses' in existing_tables:
        return

    op.create_table(
        'report_upload_statuses',
        sa.Column('id', sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column('project_id', sa.BigInteger(), sa.ForeignKey('projects.id', ondelete='CASCADE'), nullable=False),
        sa.Column('report_type', sa.String(length=32), nullable=False),
        sa.Column('country', sa.String(length=2), nullable=False, server_default='US'),
        sa.Column('report_date', sa.Date(), nullable=False),
        sa.Column('upload_file_id', sa.String(length=255), nullable=False),
        sa.Column('upload_file_path', sa.String(length=1024), nullable=False),
        sa.Column('original_filename', sa.String(length=255), nullable=True),
        sa.Column('stored_filename', sa.String(length=255), nullable=False),
        sa.Column('file_size_bytes', sa.BigInteger(), nullable=True),
        sa.Column('created_by', sa.String(length=255), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('now()')),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('now()')),
        sa.UniqueConstraint(
            'project_id',
            'report_type',
            'country',
            'report_date',
            name='report_upload_statuses_project_type_country_date_key',
        ),
    )
    op.create_index('idx_report_upload_statuses_project', 'report_upload_statuses', ['project_id'])
    op.create_index('idx_report_upload_statuses_type', 'report_upload_statuses', ['report_type'])
    op.create_index('idx_report_upload_statuses_country', 'report_upload_statuses', ['country'])
    op.create_index('idx_report_upload_statuses_report_date', 'report_upload_statuses', ['report_date'])


def downgrade() -> None:
    op.drop_index('idx_report_upload_statuses_report_date', table_name='report_upload_statuses')
    op.drop_index('idx_report_upload_statuses_country', table_name='report_upload_statuses')
    op.drop_index('idx_report_upload_statuses_type', table_name='report_upload_statuses')
    op.drop_index('idx_report_upload_statuses_project', table_name='report_upload_statuses')
    op.drop_table('report_upload_statuses')
