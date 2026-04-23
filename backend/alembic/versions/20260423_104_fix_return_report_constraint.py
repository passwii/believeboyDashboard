"""Fix ck_analysis_sources_period_or_snapshot to include return_report.

Revision ID: 20260423_104
Revises: 20260423_103
"""

from __future__ import annotations

from typing import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "20260423_104"
down_revision: str | Sequence[str] | None = "20260423_103"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint(
        "ck_analysis_sources_period_or_snapshot",
        "analysis_source_files",
        type_="check",
    )
    op.create_check_constraint(
        "ck_analysis_sources_period_or_snapshot",
        "analysis_source_files",
        "("
        "report_type in ('business_report', 'payment_report', 'ad_product_report', "
        "'sales_report', 'return_report') "
        "and period_start_date is not null "
        "and period_end_date is not null "
        "and period_start_date <= period_end_date "
        "and snapshot_at is null"
        ")"
        " or "
        "("
        "report_type = 'inventory_report' "
        "and snapshot_at is not null"
        ")",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_analysis_sources_period_or_snapshot",
        "analysis_source_files",
        type_="check",
    )
    op.create_check_constraint(
        "ck_analysis_sources_period_or_snapshot",
        "analysis_source_files",
        "("
        "report_type in ('business_report', 'payment_report', 'ad_product_report', "
        "'sales_report') "
        "and period_start_date is not null "
        "and period_end_date is not null "
        "and period_start_date <= period_end_date "
        "and snapshot_at is null"
        ")"
        " or "
        "("
        "report_type = 'inventory_report' "
        "and snapshot_at is not null"
        ")",
    )
