"""销售额统一口径（BLF-564）：DE/UK 含税、其余站点净额，所有站点含运费。

单一权威口径模块。财务月报（``services/payment/financial.py::_compute_vat_metrics``）
对 DE/UK 用 ``net_sales - income_vat_total`` 还原含税 gross；订单行类销售统计
（定时报告日/周/月、orders/summary）同样对齐：DE/UK 订单报表的 ``item-price`` /
``shipping-price`` 为税前净价，VAT 单独记在 ``item-tax`` / ``shipping-tax`` 列，
聚合销售额时须加回才是「With tax」。其余站点（US 等）订单报表无对应税列，
维持净额不变。

本模块提供三种形态，保证 SQL 聚合与 Python 逐行累加永远同一口径、同一常量源：

* :data:`VAT_INCLUSIVE_COUNTRIES` —— 含税国家集合的**唯一权威常量源**；
* :func:`sales_amount_expr` —— SQLAlchemy 聚合表达式（供查询聚合）；
* :func:`sales_amount_expr_by_row` —— 按行 ``country`` 求值的 CASE 表达式
  （单项目多站点聚合，BLF-560 spec v0.2 §5.1）；
* :func:`sales_amount_value` —— Python 标量版（供逐行累加场景：daily-analysis /
  数字大屏 / 订单统计等），与 SQL 表达式逐国家口径一致。

历史：BLF-475 建立 SQL 表达式于 ``services/scheduled_report/_sales_amount.py``；
BLF-564 迁出至 ``app/utils/sales_amount.py`` 成为中立公共模块，并新增 Python
标量版，避免「SQL 含税、Python 净额」分叉。
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from sqlalchemy import case, func

from app.models import AnalysisSalesOrderRow

# DE（19%）/ UK（20%）为 VAT-inclusive 站点。**唯一权威常量源**：
# 财务侧 financial.py 直接 import 本常量，新增站点只改这一处。
VAT_INCLUSIVE_COUNTRIES: frozenset[str] = frozenset({"DE", "UK"})


def _to_decimal(value: Any) -> Decimal:
    """把 SQLAlchemy Decimal 列值 / float / int / None 归一为 Decimal。"""
    if value is None:
        return Decimal("0")
    return value if isinstance(value, Decimal) else Decimal(str(value))


# 净额 / 含税基础表达式（sales_amount_expr / sales_amount_expr_by_row 共用，
# 保证口径一致）。
_NET_EXPR = func.coalesce(AnalysisSalesOrderRow.item_price, 0) + func.coalesce(
    AnalysisSalesOrderRow.shipping_price, 0
)
_TAX_EXPR = func.coalesce(AnalysisSalesOrderRow.item_tax, 0) + func.coalesce(
    AnalysisSalesOrderRow.shipping_tax, 0
)


def sales_amount_expr(country: str):
    """构建销售额聚合表达式。

    DE/UK 含税：``item_price + shipping_price + item_tax + shipping_tax``；
    其余站点净额：``item_price + shipping_price``（报表无税列或税列为 0）。

    Args:
        country: 站点代码（US / DE / UK，已归一化）。
    """
    if (country or "").strip().upper() in VAT_INCLUSIVE_COUNTRIES:
        return _NET_EXPR + _TAX_EXPR
    return _NET_EXPR


def sales_amount_expr_by_row():
    """按行 CASE 的销售额表达式（BLF-560 单项目多站点聚合，spec v0.2 §5.1）。

    多站点聚合时行可能来自不同国家（不同币种/含税规则），无法用单个静态
    ``country`` 参数决定表达式——改为对每一行按 ``row.country`` 求值：
    ``CASE WHEN country IN ('DE','UK') THEN net+tax ELSE net END``。

    结果与 ``sales_amount_expr(country)`` 逐国家口径完全一致（DE/UK 含税、
    其余净额），只是把判断从调用方常量下移到行值。
    """
    return case(
        (
            AnalysisSalesOrderRow.country.in_(tuple(VAT_INCLUSIVE_COUNTRIES)),
            _NET_EXPR + _TAX_EXPR,
        ),
        else_=_NET_EXPR,
    )


def sales_amount_value(
    country: str,
    *,
    item_price: Any,
    shipping_price: Any,
    item_tax: Any = 0,
    shipping_tax: Any = 0,
) -> Decimal:
    """Python 标量版销售额（逐行累加场景用），与 :func:`sales_amount_expr` 同口径。

    DE/UK 含税：``item_price + shipping_price + item_tax + shipping_tax``；
    其余站点净额：``item_price + shipping_price``。所有站点都含运费。

    Args:
        country: 站点代码（US / DE / UK，已归一化，大小写不敏感）。
        item_price: 商品售价（行值，Decimal/float/int/None 均可）。
        shipping_price: 运费。
        item_tax: 商品税（默认 0）。
        shipping_tax: 运费税（默认 0）。

    Returns:
        该行的销售额 Decimal，与 SQL 表达式逐国家口径一致。
    """
    net = _to_decimal(item_price) + _to_decimal(shipping_price)
    if (country or "").strip().upper() in VAT_INCLUSIVE_COUNTRIES:
        return net + _to_decimal(item_tax) + _to_decimal(shipping_tax)
    return net
