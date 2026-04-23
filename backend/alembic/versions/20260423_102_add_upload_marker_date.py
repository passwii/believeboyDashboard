"""Add upload_marker_date to analysis_source_files and return_analysis_records.

upload_marker_date stores the LOCAL upload date (not the business report date).
Marker rows use this field exclusively, leaving report_date/return_date NULL.

Revision ID: 20260423_102
Revises: a5571a96e542
Linear chain: a5571a96e542 is already ahead of 20260422_101 in prod.
"""

from __future__ import annotations

from typing import Sequence

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "20260423_102"
down_revision: str | Sequence[str] | None = "a5571a96e542"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "analysis_source_files",
        sa.Column("upload_marker_date", sa.Date(), nullable=True),
    )
    op.execute(
        "CREATE INDEX idx_analysis_sources_upload_marker_date "
        "ON analysis_source_files (upload_marker_date) WHERE upload_marker_date IS NOT NULL"
    )

    op.add_column(
        "return_analysis_records",
        sa.Column("upload_marker_date", sa.String(20), nullable=True),
    )
    op.execute(
        "CREATE INDEX idx_return_analysis_upload_marker_date "
        "ON return_analysis_records (upload_marker_date) "
        "WHERE upload_marker_date IS NOT NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_return_analysis_upload_marker_date")
    op.drop_column("return_analysis_records", "upload_marker_date")
    op.execute("DROP INDEX IF EXISTS idx_analysis_sources_upload_marker_date")
    op.drop_column("analysis_source_files", "upload_marker_date")
