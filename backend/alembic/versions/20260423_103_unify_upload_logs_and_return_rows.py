"""Unify upload status: create report_upload_logs and analysis_return_rows,
remove marker columns from analysis_source_files and return_analysis_records.

This migration:
1. Creates report_upload_logs as the single source of truth for RPA status
2. Creates analysis_return_rows to unify return reports into analysis_source_files
3. Removes is_upload_marker and upload_marker_date from both tables
4. Expands analysis_source_files report_type constraint to include return_report

Revision ID: 20260423_103
Revises: 20260423_102
"""

from __future__ import annotations

from typing import Sequence

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "20260423_103"
down_revision: str | Sequence[str] | None = "20260423_102"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    # ─── 1. Create report_upload_logs ──────────────────────────────────────
    op.create_table(
        "report_upload_logs",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("project_id", sa.BigInteger(), nullable=False),
        sa.Column("report_type", sa.String(32), nullable=False),
        sa.Column("country", sa.String(2), nullable=False, server_default="US"),
        sa.Column("upload_date", sa.Date(), nullable=False),
        sa.Column("has_real_data", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("row_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("source_file_id", sa.BigInteger(), nullable=True),
        sa.Column("original_filename", sa.String(255), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(
            ["project_id"], ["projects.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["source_file_id"], ["analysis_source_files.id"], ondelete="SET NULL"
        ),
    )
    op.create_index(
        "idx_upload_logs_lookup",
        "report_upload_logs",
        ["project_id", "report_type", "country", "upload_date"],
    )

    # ─── 2. Create analysis_return_rows ────────────────────────────────────
    op.create_table(
        "analysis_return_rows",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column(
            "source_file_id",
            sa.BigInteger(),
            sa.ForeignKey("analysis_source_files.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("source_row_no", sa.Integer(), nullable=False),
        sa.Column("return_date", sa.Date(), nullable=False),
        sa.Column("order_id", sa.String(50), nullable=False),
        sa.Column("sku", sa.String(100), nullable=False),
        sa.Column("asin", sa.String(20), nullable=True),
        sa.Column("fnsku", sa.String(20), nullable=True),
        sa.Column("product_name", sa.Text(), nullable=True),
        sa.Column("quantity", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("fulfillment_center_id", sa.String(20), nullable=True),
        sa.Column("detailed_disposition", sa.String(50), nullable=False),
        sa.Column("reason", sa.String(100), nullable=False),
        sa.Column("status", sa.String(100), nullable=False),
        sa.Column("license_plate_number", sa.String(30), nullable=True),
        sa.Column("original_return_datetime", sa.String(30), nullable=False),
        sa.Column("customer_comments", sa.Text(), nullable=True),
        sa.Column("raw_row", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "source_file_id", "source_row_no", name="analysis_return_rows_source_row_key"
        ),
    )
    op.create_index(
        "idx_analysis_return_source_id",
        "analysis_return_rows",
        ["source_file_id"],
    )
    op.create_index(
        "idx_analysis_return_source_date",
        "analysis_return_rows",
        ["source_file_id", "return_date"],
    )
    op.create_index(
        "idx_analysis_return_sku",
        "analysis_return_rows",
        ["sku"],
    )
    op.create_index(
        "idx_analysis_return_order_id",
        "analysis_return_rows",
        ["order_id"],
    )

    # ─── 3. Remove marker columns from analysis_source_files ───────────────
    op.drop_index("idx_analysis_sources_upload_marker_date")
    op.drop_column("analysis_source_files", "upload_marker_date")
    op.drop_column("analysis_source_files", "is_upload_marker")

    # ─── 4. Remove marker columns from return_analysis_records ─────────────
    op.drop_index("idx_return_analysis_upload_marker_date")
    op.drop_column("return_analysis_records", "upload_marker_date")
    op.drop_column("return_analysis_records", "is_upload_marker")

    # ─── 5. Expand report_type constraint to include return_report ─────────
    op.drop_constraint("ck_analysis_sources_report_type", "analysis_source_files")
    op.create_check_constraint(
        "ck_analysis_sources_report_type",
        "analysis_source_files",
        "report_type in ('business_report', 'payment_report', 'ad_product_report', "
        "'sales_report', 'inventory_report', 'return_report')",
    )


def downgrade() -> None:
    # Restore marker columns
    op.add_column(
        "return_analysis_records",
        sa.Column("is_upload_marker", sa.Boolean(), nullable=False, server_default="false"),
    )
    op.add_column(
        "return_analysis_records",
        sa.Column("upload_marker_date", sa.String(20), nullable=True),
    )
    op.execute(
        "CREATE INDEX idx_return_analysis_upload_marker_date "
        "ON return_analysis_records (upload_marker_date) WHERE upload_marker_date IS NOT NULL"
    )

    op.add_column(
        "analysis_source_files",
        sa.Column("is_upload_marker", sa.Boolean(), nullable=False, server_default="false"),
    )
    op.add_column(
        "analysis_source_files",
        sa.Column("upload_marker_date", sa.Date(), nullable=True),
    )
    op.execute(
        "CREATE INDEX idx_analysis_sources_upload_marker_date "
        "ON analysis_source_files (upload_marker_date) WHERE upload_marker_date IS NOT NULL"
    )

    # Restore report_type constraint
    op.drop_constraint("ck_analysis_sources_report_type", "analysis_source_files")
    op.create_check_constraint(
        "ck_analysis_sources_report_type",
        "analysis_source_files",
        "report_type in ('business_report', 'payment_report', 'ad_product_report', "
        "'sales_report', 'inventory_report')",
    )

    # Drop new tables
    op.drop_index("idx_analysis_return_order_id")
    op.drop_index("idx_analysis_return_sku")
    op.drop_index("idx_analysis_return_source_date")
    op.drop_index("idx_analysis_return_source_id")
    op.drop_table("analysis_return_rows")

    op.drop_index("idx_upload_logs_lookup")
    op.drop_table("report_upload_logs")
