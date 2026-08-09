"""Orders Summary service for the external API.

Returns deduplicated real orders/sales data for TACoS calculation.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import List, Optional, Sequence, Union

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.models import AnalysisSalesOrderRow, Project
from app.services.sales_query import counted_sales_where
from app.utils.math_utils import round_money, round_ratio, safe_ratio
from app.utils.sales_amount import (
    sales_amount_expr,
    sales_amount_expr_by_row,
    sales_amount_value,
)


def _to_float(value: Decimal | float | int | None) -> float:
    if value is None:
        return 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _serialize_order_row(row: AnalysisSalesOrderRow, project_name: str) -> dict:
    """Serialize an AnalysisSalesOrderRow to dict for response."""
    fulfillment_channel = (row.raw_row or {}).get("fulfillment_channel", "")
    if fulfillment_channel == "Amazon":
        fulfillment_label = "FBA（亚马逊配送）"
    elif fulfillment_channel == "Merchant":
        fulfillment_label = "FBM（自发货配送）"
    else:
        fulfillment_label = fulfillment_channel or "—"

    return {
        "amazon_order_id": row.amazon_order_id,
        "purchase_date_pt": row.purchase_date_pt.isoformat()
        if row.purchase_date_pt
        else "",
        "order_status": row.order_status,
        "fulfillment_channel": fulfillment_channel or "—",
        "fulfillment_label": fulfillment_label,
        "sku": row.sku,
        "asin": row.asin,
        "product_name": (row.raw_row or {}).get("product_name"),
        "quantity": row.quantity,
        "item_price": _to_float(row.item_price),
        "shipping_price": _to_float(row.shipping_price),
        "currency": row.currency,
        "country": row.country,
        "is_counted_sales": row.is_counted_sales,
    }


def query_orders_summary(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: date,
    date_to: date,
    include_cancelled: bool = False,
    include_pending: bool = True,
    aggregate: bool = True,
    limit: int = 50000,
    offset: int = 0,
) -> tuple[List[dict], dict]:
    """Query deduplicated orders summary for a project in a date window.

    Args:
        db: Database session
        project_id: Project ID
        country: Country code (e.g., 'US')
        date_from: Start date (inclusive)
        date_to: End date (inclusive)
        include_cancelled: If False, exclude order_status='Cancelled'
        include_pending: If True, include pending orders
        aggregate: If True, also return aggregate totals. total_sales_amount 走
            sales_amount_value（DE/UK 含税、其余净额，均含运费；不乘 quantity，
            与 grouped 模式 / 定时报表口径一致，spec §5.2）。
        limit: Max rows to return
        offset: Pagination offset

    Returns:
        Tuple of (order_rows_list, aggregate_dict)
    """
    # BEL-348: 直接按行过滤（不再依赖 source_file 版本选择），避免整文件版本
    # 把更全的旧版本覆盖掉导致丢单。
    base_stmt = select(AnalysisSalesOrderRow).where(
        *counted_sales_where(
            project_id=project_id,
            country=country,
            date_from=date_from,
            date_to=date_to,
            include_pending=include_pending,
            include_cancelled=include_cancelled,
        )
    )

    # Apply pagination
    base_stmt = base_stmt.limit(limit).offset(offset)

    rows = db.execute(base_stmt).scalars().all()

    # Serialize（project_name 由 row.project_id 关联，此处懒加载取，保持响应结构不变）
    _project_name = db.execute(
        select(Project.project_name).where(Project.id == project_id)
    ).scalar_one_or_none()
    serialized = [_serialize_order_row(row, _project_name or "") for row in rows]

    # Compute aggregates
    aggregate_data = {
        "total_orders": len(serialized),
        "total_quantity": sum(r["quantity"] for r in serialized),
        # BLF-566: 与 grouped 模式/定时报表口径一致（spec §5.2）——逐行
        # sales_amount_value(country, item+shipping(+tax))，不乘 quantity。
        "total_sales_amount": round_money(
            sum(
                sales_amount_value(
                    row.country,
                    item_price=row.item_price,
                    shipping_price=row.shipping_price,
                    item_tax=row.item_tax,
                    shipping_tax=row.shipping_tax,
                )
                for row in rows
            )
        ),
        "currency": serialized[0]["currency"] if serialized else None,
        "fba_orders": sum(
            1 for r in serialized if r["fulfillment_channel"] == "Amazon"
        ),
        "fbm_orders": sum(
            1 for r in serialized if r["fulfillment_channel"] == "Merchant"
        ),
    }

    return serialized, aggregate_data


# ────────────────────────────────────────────────────────────────────────────
# group_by 模式（BLF-558，spec docs/superpowers/specs/2026-08-09-agent-sales-data-api.md）
# ────────────────────────────────────────────────────────────────────────────

# group_by / order_by / order_dir 白名单（spec §4.2）。端点层负责 400 校验
# （agent 镜像翻译成 VALIDATION_FAILED 壳），服务层做防御性校验。
GROUP_BY_ALLOWED = frozenset({"asin", "asin_day", "day"})
ORDER_BY_ALLOWED = frozenset({"sales_amount", "quantity", "order_count"})
ORDER_DIR_ALLOWED = frozenset({"desc", "asc"})


def query_orders_summary_grouped(
    db: Session,
    *,
    project_id: int,
    country: Union[str, Sequence[str]],
    date_from: date,
    date_to: date,
    include_cancelled: bool = False,
    include_pending: bool = True,
    group_by: str,
    order_by: str = "sales_amount",
    order_dir: str = "desc",
    include_share: bool = False,
    limit: int = 500,
    offset: int = 0,
) -> tuple[list[dict], int, dict]:
    """SQL 侧 group-by 聚合已计入销售订单行（BLF-558 spec §4.2/§5；BLF-560 v0.2）。

    ``group_by`` 支持 ``asin``（TOP ASIN 排名）/ ``asin_day``（ASIN×日）/ ``day``
    （日趋势）。销售额统一走 :func:`sales_amount_expr`（DE/UK 含税）或
    :func:`sales_amount_expr_by_row`（多站点时按行 CASE），订单数 =
    ``count(distinct amazon_order_id)``（去重），product_name 取组内
    ``raw_row->>'product_name'`` 任一非空值（不联表 sku_info，单域约束）。

    ``country`` 接受单站点（str，行为与 v0.1 一致）或多站点序列
    （BLF-560 v0.2 单项目多站点聚合）：多站点时按 (group 维度 × country) 分组，
    行带 ``country``/``currency``，``summary.by_country`` 按国家分拆金额
    （币种独立，**不做跨币种求和**——系统无通用 FX）；``total_orders`` /
    ``total_quantity`` 为跨站点合计（无量纲可直接求和），顶层
    ``total_sales_amount``/``currency`` 在多站点时为 ``None``。

    返回 ``(rows, total_rows, summary)``：
    * ``rows`` —— 按 ``order_by/order_dir`` 排序的聚合行（受 limit/offset 约束）；
    * ``total_rows`` —— 全量聚合行数（不受 limit 影响）；
    * ``summary`` —— **SQL 全量汇总**（不受 limit/offset 影响），修复现有
      aggregate「页内汇总」失真问题（spec §4.2）。

    本函数**不改**现有 :func:`query_orders_summary` 的签名与行为（存量消费者零影响）。
    """
    if group_by not in GROUP_BY_ALLOWED:
        raise ValueError(f"group_by must be one of {sorted(GROUP_BY_ALLOWED)}")
    if order_by not in ORDER_BY_ALLOWED:
        raise ValueError(f"order_by must be one of {sorted(ORDER_BY_ALLOWED)}")
    if order_dir not in ORDER_DIR_ALLOWED:
        raise ValueError(f"order_dir must be one of {sorted(ORDER_DIR_ALLOWED)}")

    countries = [country] if isinstance(country, str) else list(country)
    if not countries:
        raise ValueError("country must not be empty")
    multi = len(countries) > 1

    where = counted_sales_where(
        project_id=project_id,
        country=countries,
        date_from=date_from,
        date_to=date_to,
        include_pending=include_pending,
        include_cancelled=include_cancelled,
    )

    # 金额表达式：单站点沿用 v0.1 的静态表达式（DE/UK 含税，与定时报表一致）；
    # 多站点改为按行 CASE（每行按 row.country 决定含税与否），口径完全一致。
    amount_expr = (
        sales_amount_expr_by_row() if multi else sales_amount_expr(countries[0])
    )
    qty_expr = func.sum(AnalysisSalesOrderRow.quantity).label("quantity")
    amount_sum_expr = func.sum(amount_expr).label("sales_amount")
    order_count_expr = func.count(
        func.distinct(AnalysisSalesOrderRow.amazon_order_id)
    ).label("order_count")

    if group_by == "asin":
        dim_cols = [AnalysisSalesOrderRow.asin]
    elif group_by == "asin_day":
        dim_cols = [
            AnalysisSalesOrderRow.purchase_date_pt,
            AnalysisSalesOrderRow.asin,
        ]
    else:  # day
        dim_cols = [AnalysisSalesOrderRow.purchase_date_pt]

    # 多站点：group 键 = (group 维度 × country)；单站点：维度分组不变，
    # country 用 max() 常量选择（行为与 v0.1 一致，行仍带 country 增量字段）。
    if multi:
        group_cols = [*dim_cols, AnalysisSalesOrderRow.country]
        country_sel = AnalysisSalesOrderRow.country
    else:
        group_cols = dim_cols
        country_sel = func.max(AnalysisSalesOrderRow.country)

    select_cols = [
        *dim_cols,
        country_sel.label("country"),
        func.max(AnalysisSalesOrderRow.currency).label("currency"),
        qty_expr,
        amount_sum_expr,
        order_count_expr,
    ]
    if group_by in ("asin", "asin_day"):
        select_cols.append(
            func.max(AnalysisSalesOrderRow.raw_row["product_name"].as_string()).label(
                "product_name"
            )
        )
    if group_by == "day":
        select_cols.append(
            func.count(func.distinct(AnalysisSalesOrderRow.asin)).label("unique_asins")
        )

    order_expr_map = {
        "sales_amount": amount_sum_expr,
        "quantity": qty_expr,
        "order_count": order_count_expr,
    }
    order_clause = order_expr_map[order_by].desc()
    if order_dir == "asc":
        order_clause = order_expr_map[order_by].asc()

    stmt = (
        select(*select_cols)
        .where(*where)
        .group_by(*group_cols)
        .order_by(order_clause)
        .limit(limit)
        .offset(offset)
    )

    # 全量聚合行数（不受 limit/offset 影响）。
    count_stmt = select(func.count()).select_from(
        select(*group_cols).where(*where).group_by(*group_cols).subquery()
    )
    total_rows = db.execute(count_stmt).scalar_one()

    # SQL 全量汇总（spec §4.3 summary 块）：同样不受 limit/offset 影响。
    # fulfillment-channel 在 raw_row JSON 内（订单报表表头为连字符键；order_info
    # 服务同时兼容空格键），两键均缺失时按空串处理（不计入 FBA/FBM）。
    fulfillment_expr = func.coalesce(
        AnalysisSalesOrderRow.raw_row["fulfillment-channel"].as_string(),
        AnalysisSalesOrderRow.raw_row["fulfillment channel"].as_string(),
        "",
    )

    # by_country 分拆（v0.2）：按国家分组 → 每站 currency/金额/订单数/数量。
    # 金额按国家独立结算，不做跨币种求和（系统无通用 FX）。
    by_country_stmt = (
        select(
            AnalysisSalesOrderRow.country.label("country"),
            func.max(AnalysisSalesOrderRow.currency).label("currency"),
            order_count_expr.label("total_orders"),
            func.sum(AnalysisSalesOrderRow.quantity).label("total_quantity"),
            func.sum(amount_expr).label("total_sales_amount"),
        )
        .where(*where)
        .group_by(AnalysisSalesOrderRow.country)
    )
    by_country_rows = db.execute(by_country_stmt).all()
    by_country: dict[str, dict] = {}
    for r in by_country_rows:
        by_country[r.country] = {
            "currency": r.currency,
            # 保留原始 Decimal 供 share 计算，序列化时再 round_money。
            "total_sales_amount": r.total_sales_amount,
            "total_orders": int(r.total_orders or 0),
            "total_quantity": int(r.total_quantity or 0),
        }

    # 顶层 fba/fbm（无量纲计数，跨站点可合计；count distinct 订单号）。
    fba_fbm_stmt = select(
        func.count(
            func.distinct(
                case(
                    (
                        fulfillment_expr == "Amazon",
                        AnalysisSalesOrderRow.amazon_order_id,
                    ),
                )
            )
        ).label("fba_orders"),
        func.count(
            func.distinct(
                case(
                    (
                        fulfillment_expr == "Merchant",
                        AnalysisSalesOrderRow.amazon_order_id,
                    ),
                )
            )
        ).label("fbm_orders"),
    ).where(*where)
    fba_fbm = db.execute(fba_fbm_stmt).one()

    if multi:
        # 跨站点合计只含无量纲项（订单数/数量）；金额类按国家分拆在 by_country。
        summary = {
            "total_orders": sum(b["total_orders"] for b in by_country.values()),
            "total_quantity": sum(b["total_quantity"] for b in by_country.values()),
            "total_sales_amount": None,
            "currency": None,
            "fba_orders": int(fba_fbm.fba_orders or 0),
            "fbm_orders": int(fba_fbm.fbm_orders or 0),
            "by_country": {
                c: {
                    "currency": b["currency"],
                    "total_sales_amount": round_money(b["total_sales_amount"]),
                    "total_orders": b["total_orders"],
                    "total_quantity": b["total_quantity"],
                }
                for c, b in by_country.items()
            },
        }
    else:
        c = countries[0]
        b = by_country.get(c)
        if b is None:
            b = {
                "currency": None,
                "total_sales_amount": None,
                "total_orders": 0,
                "total_quantity": 0,
            }
        summary = {
            "total_orders": b["total_orders"],
            "total_quantity": b["total_quantity"],
            "total_sales_amount": round_money(b["total_sales_amount"]),
            "currency": b["currency"],
            "fba_orders": int(fba_fbm.fba_orders or 0),
            "fbm_orders": int(fba_fbm.fbm_orders or 0),
            "by_country": {
                c: {
                    "currency": b["currency"],
                    "total_sales_amount": round_money(b["total_sales_amount"]),
                    "total_orders": b["total_orders"],
                    "total_quantity": b["total_quantity"],
                }
            },
        }

    rows: list[dict] = []
    for row in db.execute(stmt).all():
        country_val = row.country
        if group_by == "asin":
            item: dict = {
                "country": country_val,
                "currency": row.currency,
                "asin": row.asin,
                "product_name": row.product_name,
                "quantity": int(row.quantity or 0),
                "sales_amount": round_money(row.sales_amount),
                "order_count": int(row.order_count or 0),
            }
            if include_share:
                # v0.2：share 按国家内结算（sales_amount / Σ同国家 sales_amount）。
                denom = by_country.get(country_val, {}).get("total_sales_amount")
                item["share"] = round_ratio(safe_ratio(row.sales_amount, denom))
        elif group_by == "asin_day":
            item = {
                "country": country_val,
                "currency": row.currency,
                "date": row.purchase_date_pt.isoformat(),
                "asin": row.asin,
                "product_name": row.product_name,
                "quantity": int(row.quantity or 0),
                "sales_amount": round_money(row.sales_amount),
                "order_count": int(row.order_count or 0),
            }
        else:  # day
            item = {
                "country": country_val,
                "currency": row.currency,
                "date": row.purchase_date_pt.isoformat(),
                "quantity": int(row.quantity or 0),
                "sales_amount": round_money(row.sales_amount),
                "order_count": int(row.order_count or 0),
                "unique_asins": int(row.unique_asins or 0),
            }
        rows.append(item)

    return rows, total_rows, summary
