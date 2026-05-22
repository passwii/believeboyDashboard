"""Add result R2 storage fields to AnalysisPT1Calculation.

This migration adds R2 storage fields to the analysis_pt1_calculation table,
enabling storage of product analysis result files in Cloudflare R2 instead of
local filesystem.

The new fields store:
- result_r2_key: R2 object key (e.g., "项目名/product-analysis/123/result.xlsx")
- result_r2_url: Public URL for direct access

This replaces the local filesystem path stored in result_file_path.

Revision ID: 133
Revises: 132
Create Date: 2026-05-22

"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "133"
down_revision = "132"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "analysis_pt1_calculation",
        sa.Column("result_r2_key", sa.String(512), nullable=True),
    )
    op.add_column(
        "analysis_pt1_calculation",
        sa.Column("result_r2_url", sa.String(1024), nullable=True),
    )
    # Add index for faster lookups
    op.create_index(
        "idx_analysis_pt1_result_r2_key",
        "analysis_pt1_calculation",
        ["result_r2_key"],
        unique=False,
        postgresql_where=sa.text("result_r2_key IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("idx_analysis_pt1_result_r2_key", table_name="analysis_pt1_calculation")
    op.drop_column("analysis_pt1_calculation", "result_r2_url")
    op.drop_column("analysis_pt1_calculation", "result_r2_key")