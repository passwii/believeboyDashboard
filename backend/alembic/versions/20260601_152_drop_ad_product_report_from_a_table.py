"""drop ad_product_report from analysis_source_files (Step 8 A 表下线)

ad_product_report 已切到 C 表 (ad_upload_files)。A 表 analysis_source_files / analysis_ad_product_rows
不再需要 ad_product_report 数据:
- analysis_source_files 中 1497 个 ad_product_report 行
- analysis_ad_product_rows 中 26420 个关联行 (FK CASCADE)

把 report_type 的 CHECK constraint 移除 ad_product_report 防止未来误用。

降级 (downgrade) 注意：已删除的 26420 行无法恢复，只能重置 CHECK constraint。

Revision ID: 152
Revises: 151
Create Date: 2026-06-01
"""
from alembic import op


revision = "152"
down_revision = "151"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1) 删 A 表 ad_product_report 数据
    #    analysis_ad_product_rows 通过 FK CASCADE 自动删除
    op.execute(
        "DELETE FROM analysis_source_files WHERE report_type = 'ad_product_report'"
    )

    # 2) 改 CHECK constraint 移除 ad_product_report
    op.drop_constraint(
        "ck_analysis_sources_report_type",
        "analysis_source_files",
        type_="check",
    )
    op.create_check_constraint(
        "ck_analysis_sources_report_type",
        "analysis_source_files",
        "report_type in ('business_report', 'payment_report', 'sales_report', 'inventory_report', 'return_report')",
    )

    op.drop_constraint(
        "ck_analysis_sources_period_or_snapshot",
        "analysis_source_files",
        type_="check",
    )
    op.create_check_constraint(
        "ck_analysis_sources_period_or_snapshot",
        "analysis_source_files",
        (
            "("
            "report_type in ('business_report', 'payment_report', 'sales_report', 'return_report') "
            'and period_start_date is not null '
            'and period_end_date is not null '
            'and period_start_date <= period_end_date '
            'and snapshot_at is null'
            ")"
            " or "
            "("
            "report_type = 'inventory_report' "
            'and snapshot_at is not null'
            ")"
        ),
    )


def downgrade() -> None:
    # downgrade 不能恢复已删除数据, 只能重置 CHECK constraint (让 schema 跟 151 一致)
    op.drop_constraint(
        "ck_analysis_sources_report_type",
        "analysis_source_files",
        type_="check",
    )
    op.create_check_constraint(
        "ck_analysis_sources_report_type",
        "analysis_source_files",
        "report_type in ('business_report', 'payment_report', 'ad_product_report', 'sales_report', 'inventory_report', 'return_report')",
    )

    op.drop_constraint(
        "ck_analysis_sources_period_or_snapshot",
        "analysis_source_files",
        type_="check",
    )
    op.create_check_constraint(
        "ck_analysis_sources_period_or_snapshot",
        "analysis_source_files",
        (
            "("
            "report_type in ('business_report', 'payment_report', 'ad_product_report', 'sales_report', 'return_report') "
            'and period_start_date is not null '
            'and period_end_date is not null '
            'and period_start_date <= period_end_date '
            'and snapshot_at is null'
            ")"
            " or "
            "("
            "report_type = 'inventory_report' "
            'and snapshot_at is not null'
            ")"
        ),
    )
