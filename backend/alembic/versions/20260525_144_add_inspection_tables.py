"""add_inspection_tables

Revision ID: 144
Revises: 143
Create Date: 2026-05-25 00:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '144'
down_revision: Union[str, None] = '143'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'inspection_periods',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('week_start', sa.Date(), nullable=False),
        sa.Column('week_end', sa.Date(), nullable=False),
        sa.Column('deadline', sa.DateTime(timezone=True), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('now()')),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('week_start', name='uq_inspection_periods_week_start'),
    )
    op.create_index('idx_inspection_periods_week_start', 'inspection_periods', ['week_start'])

    op.create_table(
        'inspection_reports',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('period_id', sa.BigInteger(), nullable=False),
        sa.Column('project_id', sa.BigInteger(), nullable=False),
        sa.Column('status', sa.String(length=16), nullable=False, server_default='draft'),
        sa.Column('health_data', sa.JSON(), nullable=True),
        sa.Column('compliance_data', sa.JSON(), nullable=True),
        sa.Column('status_summary', sa.Text(), nullable=True),
        sa.Column('submitted_by', sa.String(length=128), nullable=True),
        sa.Column('submitted_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('now()')),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('now()')),
        sa.PrimaryKeyConstraint('id'),
        sa.ForeignKeyConstraint(['period_id'], ['inspection_periods.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
        sa.UniqueConstraint('period_id', 'project_id', name='uq_inspection_reports_period_project'),
    )
    op.create_index('idx_inspection_reports_period_id', 'inspection_reports', ['period_id'])
    op.create_index('idx_inspection_reports_project_id', 'inspection_reports', ['project_id'])
    op.create_index('idx_inspection_reports_period_status', 'inspection_reports', ['period_id', 'status'])

    op.create_table(
        'inspection_screenshots',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('report_id', sa.BigInteger(), nullable=False),
        sa.Column('r2_key', sa.String(length=512), nullable=False),
        sa.Column('filename', sa.String(length=256), nullable=False),
        sa.Column('content_type', sa.String(length=64), nullable=False),
        sa.Column('file_size', sa.Integer(), nullable=False),
        sa.Column('caption', sa.String(length=256), nullable=True),
        sa.Column('sort_order', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('now()')),
        sa.PrimaryKeyConstraint('id'),
        sa.ForeignKeyConstraint(['report_id'], ['inspection_reports.id'], ondelete='CASCADE'),
    )
    op.create_index('idx_inspection_screenshots_report_id', 'inspection_screenshots', ['report_id'])


def downgrade() -> None:
    op.drop_table('inspection_screenshots')
    op.drop_table('inspection_reports')
    op.drop_table('inspection_periods')
