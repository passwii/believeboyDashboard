"""rename store_sku_pricing_snapshots to new_product_calculations

Revision ID: 230
Revises: 229
Create Date: 2026-08-03

BEL-378 命名重构（用户拍板：方案 A = 连表一起改）：

将 ``store_sku_pricing_snapshots`` 表重命名为 ``new_product_calculations``，
与"新品核算"语义对齐（旧的 store-sku-pricing 命名是历史遗留，与实际功能
"新品核算"不符）。原表 99 行数据随 ALTER TABLE ... RENAME 自动保留，
应用层通过 model 改名（NewProductCalculation + __tablename__）继续读写。

**注意**：本次只改表名 + model 类名 + 派生标识符，不动列结构 / 索引 / 约束。
downgrade 同样 RENAME 回原名（无数据迁移，零风险）。
"""

from alembic import op


revision = "230"
down_revision = "229"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.rename_table("store_sku_pricing_snapshots", "new_product_calculations")


def downgrade() -> None:
    op.rename_table("new_product_calculations", "store_sku_pricing_snapshots")
