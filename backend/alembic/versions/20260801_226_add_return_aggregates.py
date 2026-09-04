"""add return aggregates table

Revision ID: 226
Revises: 225
Create Date: 2026-08-01

BEL-373 数据层（BEL-372 拍板方案 §2.1）：
- analysis_return_aggregates 表：每日 03:00 UTC Celery 增量刷新
- 物化"单日 × SKU × country"的退货指标 + Wilson 95% 下界 + risk_level
- 内部 /api/v1/return-analysis 优先读快照，25h 未刷新走 fallback 现场算

设计要点：
- 主键 id INTEGER（与 alert_rule.py 屋风一致）
- 唯一键 (project_id, country, sku, data_date) —— 增量 upsert 友好
- 3 个索引覆盖主查询模式（按项目日期 / 按 SKU / 按风险等级筛选）
- data_date 单日而非整周期，endpoint 查询时按 data_date BETWEEN start AND end 聚合
"""

from alembic import op
import sqlalchemy as sa

revision = "226"
down_revision = "225"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "analysis_return_aggregates",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("project_id", sa.Integer(), nullable=False),
        sa.Column("country", sa.String(length=2), nullable=False),
        sa.Column("sku", sa.String(length=100), nullable=False),
        sa.Column("asin", sa.String(length=20), nullable=True),
        sa.Column("data_date", sa.Date(), nullable=False, comment="退货日期（PT）"),
        sa.Column(
            "return_count",
            sa.Integer(),
            nullable=False,
            server_default="0",
            comment="退货单数（按 order_id+sku 去重）",
        ),
        sa.Column(
            "return_quantity",
            sa.Integer(),
            nullable=False,
            server_default="0",
            comment="退货件数（累加）",
        ),
        sa.Column(
            "sales_quantity",
            sa.Integer(),
            nullable=False,
            server_default="0",
            comment="同期销售件数（join）",
        ),
        sa.Column(
            "return_rate",
            sa.Numeric(precision=6, scale=3),
            nullable=False,
            server_default="0",
            comment="return_quantity / sales_quantity * 100",
        ),
        sa.Column("cycle_avg_days", sa.Numeric(precision=6, scale=2), nullable=True),
        sa.Column("cycle_min_days", sa.Integer(), nullable=True),
        sa.Column("cycle_max_days", sa.Integer(), nullable=True),
        sa.Column("reason_top1", sa.String(length=100), nullable=True),
        sa.Column("reason_top1_pct", sa.Numeric(precision=5, scale=2), nullable=True),
        sa.Column("reason_top1_display", sa.String(length=64), nullable=True),
        sa.Column("disposition_top1", sa.String(length=50), nullable=True),
        sa.Column("disposition_top1_display", sa.String(length=64), nullable=True),
        sa.Column("dominant_fc_id", sa.String(length=20), nullable=True),
        sa.Column(
            "risk_level",
            sa.String(length=16),
            nullable=False,
            server_default="normal",
            comment="critical/warning/normal/no_data",
        ),
        sa.Column(
            "wilson_lower",
            sa.Numeric(precision=6, scale=3),
            nullable=True,
            comment="Wilson 95% 下界（百分比），便于 audit",
        ),
        sa.Column(
            "data_version",
            sa.Integer(),
            nullable=False,
            server_default="1",
            comment="数据版本号，便于后续 schema 演进",
        ),
        sa.Column(
            "computed_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.UniqueConstraint(
            "project_id",
            "country",
            "sku",
            "data_date",
            name="uq_return_agg_project_country_sku_date",
        ),
    )
    op.create_index(
        "idx_return_agg_project_date",
        "analysis_return_aggregates",
        ["project_id", "data_date"],
    )
    op.create_index(
        "idx_return_agg_project_sku_date",
        "analysis_return_aggregates",
        ["project_id", "sku", "data_date"],
    )
    op.create_index(
        "idx_return_agg_risk",
        "analysis_return_aggregates",
        ["project_id", "country", "risk_level", "data_date"],
    )


def downgrade() -> None:
    op.drop_index("idx_return_agg_risk", table_name="analysis_return_aggregates")
    op.drop_index(
        "idx_return_agg_project_sku_date", table_name="analysis_return_aggregates"
    )
    op.drop_index(
        "idx_return_agg_project_date", table_name="analysis_return_aggregates"
    )
    op.drop_table("analysis_return_aggregates")
