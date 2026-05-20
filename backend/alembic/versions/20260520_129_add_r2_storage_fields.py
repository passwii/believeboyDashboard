"""Add R2 storage fields to monthly_reports

Revision ID: 129
Revises: 128
Create Date: 2026-05-20 16:00:00

This migration adds R2 cloud storage fields to replace local file storage:
- summary_pdf_r2_key: R2 object key (e.g., project/monthly-summary-pdf/abc.pdf)
- summary_pdf_r2_url: Public URL for direct access
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '129'
down_revision: Union[str, None] = '128'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add new R2 fields for summary PDF
    op.add_column('monthly_reports', sa.Column('summary_pdf_r2_key', sa.String(512), nullable=True))
    op.add_column('monthly_reports', sa.Column('summary_pdf_r2_url', sa.String(1024), nullable=True))


def downgrade() -> None:
    op.drop_column('monthly_reports', 'summary_pdf_r2_url')
    op.drop_column('monthly_reports', 'summary_pdf_r2_key')