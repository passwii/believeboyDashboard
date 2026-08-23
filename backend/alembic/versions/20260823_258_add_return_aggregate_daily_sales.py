"""退货分析聚合表增当日销量列 daily_sales_quantity（BLF-806）

Revision ID: 258
Revises: 257
Create Date: 2026-08-23

BLF-806 口径对齐：R2 per-SKU 窗口折叠此前对 sales_quantity（BEL-376 全期
累计语义）取 max，得到的是全历史累计销量而非窗口内销量，导致 return_rate /
risk_level 分母被系统性放大。新增可空列 daily_sales_quantity 存「当日」
counted sales；读侧对窗口内逐日求 SUM 即与 R1 overview 同口径。

- NULL = 迁移前写入的旧行（尚无当日销量），每日刷新任务的缺口检测会把
  这些日期视为缺口自动重算补齐，无需手工数据迁移。
- 旧列 sales_quantity 保持 cumulative 语义不变（audit 用）。
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op


# revision identifiers, used by Alembic.
revision: str = "258"
down_revision: str | None = "257"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.add_column(
        "analysis_return_aggregates",
        sa.Column(
            "daily_sales_quantity",
            sa.Integer(),
            nullable=True,
            comment="当日销量（BLF-806）；NULL=迁移前旧行，待刷新任务重算",
        ),
    )


def downgrade() -> None:
    op.drop_column("analysis_return_aggregates", "daily_sales_quantity")
