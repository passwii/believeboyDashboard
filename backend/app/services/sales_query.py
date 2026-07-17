"""BEL-348: 销售订单行统一计数过滤。

改版后销售订单行按 (project_id, amazon_order_id, sku, country) 行级 upsert，
计数/查询直接按行过滤，不再依赖 source_file 的版本选择（MAX(version) is_current）。
所有需要"已计入销售订单行"的服务都应走本模块的 ``counted_sales_where``，
避免各自 JOIN source_file + is_current 导致丢单（见 BEL-348 根因）。
"""
from __future__ import annotations

from datetime import date
from typing import List

from sqlalchemy import ColumnElement, and_

from app.models import AnalysisSalesOrderRow


def counted_sales_where(
    *,
    project_id: int,
    country: str,
    date_from: date,
    date_to: date,
    include_pending: bool = True,
    include_cancelled: bool = False,
) -> ColumnElement:
    """返回过滤"已计入销售订单行"的 WHERE 子句（直接按行，不依赖 source_file 版本）。

    过滤条件：同一项目 + 同一国家 + 购买日期在窗口内 + is_counted_sales。
    可选排除 Cancelled / Pending。
    """
    clauses: List[ColumnElement] = [
        AnalysisSalesOrderRow.project_id == project_id,
        AnalysisSalesOrderRow.country == country,
        AnalysisSalesOrderRow.purchase_date_pt >= date_from,
        AnalysisSalesOrderRow.purchase_date_pt <= date_to,
        AnalysisSalesOrderRow.is_counted_sales.is_(True),
    ]
    if not include_cancelled:
        clauses.append(AnalysisSalesOrderRow.order_status != "Cancelled")
    if not include_pending:
        clauses.append(AnalysisSalesOrderRow.order_status != "Pending")
    return and_(*clauses)
