"""BEL-348: 销售订单行统一计数过滤。

改版后销售订单行按 (project_id, amazon_order_id, sku, country) 行级 upsert，
计数/查询直接按行过滤，不再依赖 source_file 的版本选择（MAX(version) is_current）。
所有需要"已计入销售订单行"的服务都应走本模块的 ``counted_sales_where``，
避免各自 JOIN source_file + is_current 导致丢单（见 BEL-348 根因）。
"""

from __future__ import annotations

from datetime import date
from typing import List, Sequence, Union

from sqlalchemy import ColumnElement, and_

from app.models import AnalysisSalesOrderRow

CountryParam = Union[str, Sequence[str]]

# 「待发货」订单状态集合（Amazon 订单报表原始状态文本，大小写不敏感匹配）。
# Pending = 已下单未进入处理队列；Unshipped = 已处理未发货——两者均为
# 「已下单、尚未发货」口径（BLF-811），Shipped / Cancelled 不计。
PENDING_SHIPMENT_STATUSES: frozenset[str] = frozenset({"pending", "unshipped"})


def counted_sales_where(
    *,
    project_id: int,
    country: CountryParam,
    date_from: date,
    date_to: date,
    include_pending: bool = True,
    include_cancelled: bool = False,
) -> ColumnElement:
    """返回过滤"已计入销售订单行"的 WHERE 子句（直接按行，不依赖 source_file 版本）。

    过滤条件：同一项目 + 同一（些）国家 + 购买日期在窗口内 + is_counted_sales。
    可选排除 Cancelled / Pending。

    ``country`` 接受单站点代码（str，行为与历史一致）或多站点代码序列
    （BLF-560 单项目多站点聚合，spec v0.2 §5.2：多站点时用 ``IN (...)``）。
    """
    if isinstance(country, str):
        country_clause: ColumnElement = AnalysisSalesOrderRow.country == country
    else:
        country_list = list(country)
        country_clause = (
            AnalysisSalesOrderRow.country == country_list[0]
            if len(country_list) == 1
            else AnalysisSalesOrderRow.country.in_(country_list)
        )
    clauses: List[ColumnElement] = [
        AnalysisSalesOrderRow.project_id == project_id,
        country_clause,
        AnalysisSalesOrderRow.purchase_date_pt >= date_from,
        AnalysisSalesOrderRow.purchase_date_pt <= date_to,
        AnalysisSalesOrderRow.is_counted_sales.is_(True),
    ]
    if not include_cancelled:
        clauses.append(AnalysisSalesOrderRow.order_status != "Cancelled")
    if not include_pending:
        clauses.append(AnalysisSalesOrderRow.order_status != "Pending")
    return and_(*clauses)
