"""销售额聚合表达式（BLF-475）：DE/UK 含税口径。

财务月报（``services/payment/financial.py::_compute_vat_metrics``）对 DE/UK
用 ``net_sales - income_vat_total`` 还原含税 gross；定时报告同样对齐：
DE/UK 订单报表的 ``item-price`` / ``shipping-price`` 为税前净价，VAT 单独记在
``item-tax`` / ``shipping-tax`` 列，聚合销售额时须加回才是「With tax」。
其余站点（US 等）订单报表无对应税列，维持净额不变——与财务侧
``VAT_INCLUSIVE_COUNTRIES``（仅 DE/UK）短路分支一致。

所有日/周/月定时报告销售聚合统一经 :func:`sales_amount_expr`，保证三张报表
口径一致，避免日后某处漏改造成同一批订单数字对不上。
"""

from __future__ import annotations

from sqlalchemy import case, func

from app.models import AnalysisSalesOrderRow

# DE（19%）/ UK（20%）为 VAT-inclusive 站点。与财务侧
# services/payment/financial.py 的 VAT_INCLUSIVE_COUNTRIES 保持一致。
VAT_INCLUSIVE_COUNTRIES: frozenset[str] = frozenset({"DE", "UK"})


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
