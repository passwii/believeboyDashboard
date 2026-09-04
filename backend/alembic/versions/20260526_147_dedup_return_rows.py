"""Dedup return rows with unique constraint and ON CONFLICT support.

Revision ID: 147
Revises: 146
Create Date: 2026-05-26
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "147"
down_revision: str = "146"
branch_labels: None = None
depends_on: None = None


def upgrade() -> None:
    # Step 1: Add project_id and country columns (nullable initially for backfill)
    op.add_column("analysis_return_rows", sa.Column("project_id", sa.BigInteger(), nullable=True))
    op.add_column("analysis_return_rows", sa.Column("country", sa.String(2), nullable=True))

    # Step 2: Backfill from analysis_source_files
    op.execute("""
        UPDATE analysis_return_rows r
        SET project_id = s.project_id, country = s.country
        FROM analysis_source_files s
        WHERE r.source_file_id = s.id
    """)

    # Step 3: Set NOT NULL
    op.alter_column("analysis_return_rows", "project_id", nullable=False)
    op.alter_column("analysis_return_rows", "country", nullable=False)

    # Step 4: Handle license_plate_number NULLs (PostgreSQL UNIQUE: NULL != NULL)
    op.execute("UPDATE analysis_return_rows SET license_plate_number = '' WHERE license_plate_number IS NULL")

    # Use batch mode for SQLite compatibility; direct ALTER for PostgreSQL
    op.alter_column(
        "analysis_return_rows", "license_plate_number",
        existing_type=sa.String(30), nullable=False, server_default="",
    )

    # Step 5: Dedup — keep only latest source_file_id per business key
    op.execute("""
        DELETE FROM analysis_return_rows
        WHERE id IN (
            SELECT id FROM (
                SELECT id,
                    ROW_NUMBER() OVER (
                        PARTITION BY project_id, country, order_id, sku, return_date, license_plate_number
                        ORDER BY source_file_id DESC
                    ) AS rn
                FROM analysis_return_rows
            ) sub WHERE rn > 1
        )
    """)

    # Step 6: Create unique constraint
    op.create_unique_constraint(
        "uq_return_event", "analysis_return_rows",
        ["project_id", "country", "order_id", "sku", "return_date", "license_plate_number"],
    )

    # Step 7: Add foreign key
    op.create_foreign_key(
        "fk_return_rows_project", "analysis_return_rows",
        "projects", ["project_id"], ["id"], ondelete="CASCADE",
    )

    # Step 8: Indexes for common query patterns
    op.create_index("idx_return_rows_project_date", "analysis_return_rows", ["project_id", "return_date"])
    op.create_index("idx_return_rows_project_sku", "analysis_return_rows", ["project_id", "sku"])
    # order_id standalone index already exists as idx_analysis_return_order_id


def downgrade() -> None:
    op.drop_index("idx_return_rows_project_sku", table_name="analysis_return_rows")
    op.drop_index("idx_return_rows_project_date", table_name="analysis_return_rows")
    op.drop_constraint("fk_return_rows_project", "analysis_return_rows", type_="foreignkey")
    op.drop_constraint("uq_return_event", "analysis_return_rows", type_="unique")
    op.alter_column("analysis_return_rows", "license_plate_number",
                    existing_type=sa.String(30), nullable=True, server_default=None)
    op.drop_column("analysis_return_rows", "country")
    op.drop_column("analysis_return_rows", "project_id")
