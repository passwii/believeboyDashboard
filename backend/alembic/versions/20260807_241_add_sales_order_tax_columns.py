"""add item_tax/shipping_tax to analysis_sales_order_rows (BLF-475)

Revision ID: 241
Revises: 240
Create Date: 2026-08-07

定时报告对齐财务月报的含税口径（BLF-475）：DE/UK 订单报表的 ``item-tax`` /
``shipping-tax``（VAT）需要计入销售额聚合。新增两列并从原始行 ``raw_row`` JSON
回填存量数据——``raw_row`` 保留上传报表的原始列，含 ``item-tax`` / ``shipping-tax``。

回填规则：值可解析为十进制数字则取用（数值、负值、含小数）；否则（缺失/空/
非数字）落 0，与解析器 ``to_decimal`` 对不可解析值的兜底一致。
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "241"
down_revision: Union[str, None] = "240"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# 仅匹配纯十进制数字（含负号 / 小数点），避免 ''、'1,59' 等值强转抛错。
_TAX_NUMERIC_RE = r"^-?[0-9]+(\.[0-9]+)?$"


def upgrade() -> None:
    op.add_column(
        "analysis_sales_order_rows",
        sa.Column("item_tax", sa.Numeric(18, 2), nullable=False, server_default="0"),
    )
    op.add_column(
        "analysis_sales_order_rows",
        sa.Column(
            "shipping_tax", sa.Numeric(18, 2), nullable=False, server_default="0"
        ),
    )
    # 存量回填：raw_row->>'item-tax' 在 JSON 缺键/值为 NULL 时返回 NULL，
    # `~` 正则对 NULL 得 NULL → CASE 走 ELSE 落 0。
    op.execute(
        f"""
        UPDATE analysis_sales_order_rows
        SET item_tax = CASE
                WHEN raw_row->>'item-tax' ~ '{_TAX_NUMERIC_RE}'
                     THEN (raw_row->>'item-tax')::numeric
                ELSE 0
            END,
            shipping_tax = CASE
                WHEN raw_row->>'shipping-tax' ~ '{_TAX_NUMERIC_RE}'
                     THEN (raw_row->>'shipping-tax')::numeric
                ELSE 0
            END
        """
    )


def downgrade() -> None:
    op.drop_column("analysis_sales_order_rows", "shipping_tax")
    op.drop_column("analysis_sales_order_rows", "item_tax")
