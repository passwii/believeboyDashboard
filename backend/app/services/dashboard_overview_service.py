"""Dashboard KPI 总览聚合服务"""

from __future__ import annotations

import logging
from collections import Counter
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models import AnalysisSalesOrderRow, AnalysisSourceFile, SkuRecord
from app.services import digital_display_service
from app.services import project_service
from app.utils.math_utils import round_money

logger = logging.getLogger(__name__)


def _safe_pct_change(current: float, prev: float) -> tuple[float, str]:
    if prev == 0:
        return 0.0, "neutral"
    change = ((current - prev) / prev) * 100
    if abs(change) < 0.5:
        return round(change, 2), "neutral"
    return round(change, 2), "up" if change > 0 else "down"


def build_dashboard_overview(
    db: Session,
    project_ids: list[int] | None,
    operator: str | None,
    is_admin: bool,
    country: str = "US",
    days: int = 7,
    reference_date: date | None = None,
) -> dict:
    """聚合所有可访问项目的数字大屏数据，返回单一概览响应。

    Args:
        reference_date: 用于替代 date.today() 的基准日期。
            传入对应国家时区的"今天"可确保跨时区查询正确。
            为 None 时回退到服务器本地 date.today()。
    """

    # 1. 获取可访问项目列表
    if project_ids is not None and len(project_ids) == 0:
        return _empty_response(country, days)

    if project_ids:
        # 指定了 project_ids（可能来自前端筛选器），验证访问权限
        valid_ids = []
        valid_names = []
        for pid in project_ids:
            try:
                row = project_service.ensure_project_access(
                    db, pid, operator=operator, is_admin=is_admin
                )
                valid_ids.append(pid)
                valid_names.append(row.project_name)
            except Exception:
                pass
        if not valid_ids:
            return _empty_response(country, days)
    else:
        # 未指定 → 获取当前用户可访问的全部项目
        projects = project_service.list_project_items(
            db, operator=operator, is_admin=is_admin
        )
        valid_ids = [int(p.id) for p in projects]
        valid_names = [p.project_name for p in projects]

    if not valid_ids:
        return _empty_response(country, days)

    normalized_country = country.strip() or "US"
    today = reference_date or date.today()
    period_start = today - timedelta(days=days - 1)

    # 2. 初始化累加器
    # 销售
    total_today_qty = 0
    total_today_amount = 0.0
    total_yesterday_qty = 0
    total_yesterday_amount = 0.0
    total_prev_qty = 0
    total_prev_amount = 0.0
    # 趋势（按日期对齐）
    trend_map: dict[str, dict[str, float | int]] = {}
    for offset in range(days):
        d = today - timedelta(days=offset)
        trend_map[d.isoformat()] = {"order_qty": 0, "sales_amount": 0.0}

    # 库存
    total_sku_count = 0
    total_oos_count = 0
    total_available_qty = 0

    # 发货
    total_in_transit_count = 0
    total_in_transit_qty = 0

    # 退货
    total_returns = 0
    total_return_qty = 0
    return_reason_counter: Counter[str] = Counter()
    total_sales_qty_for_return = 0.0

    # 广告
    total_ad_spend = 0.0
    total_ad_sales = 0.0
    total_ad_impressions = 0
    total_ad_clicks = 0
    total_ad_orders = 0

    # 3. 逐项目查询并累加
    for pid in valid_ids:
        # 销售
        try:
            sales = digital_display_service._build_sales_snapshot(
                db, pid, normalized_country, today, days
            )
            total_today_qty += sales["today_order_qty"]
            total_today_amount += sales["today_sales_amount"]
            total_yesterday_qty += sales.get("yesterday_order_qty", 0)
            total_yesterday_amount += sales.get("yesterday_sales_amount", 0.0)
            total_prev_qty += sales["prev_order_qty"]
            total_prev_amount += sales["prev_sales_amount"]
            for item in sales["trend"]:
                date_str = item["date"]
                if date_str in trend_map:
                    trend_map[date_str]["order_qty"] += item["order_qty"]
                    trend_map[date_str]["sales_amount"] += item["sales_amount"]
        except Exception as e:
            logger.warning("Sales snapshot failed for project %s: %s", pid, e)

        # 库存
        try:
            inv = digital_display_service._build_inventory_snapshot(
                db, pid, normalized_country
            )
            total_sku_count += inv["sku_count"]
            total_oos_count += inv["out_of_stock_count"]
            total_available_qty += inv["available_qty"]
        except Exception as e:
            logger.warning("Inventory snapshot failed for project %s: %s", pid, e)

        # 发货
        try:
            ship = digital_display_service._build_shipment_snapshot(
                db, pid, normalized_country
            )
            total_in_transit_count += ship["in_transit_count"]
            total_in_transit_qty += ship["in_transit_qty"]
        except Exception as e:
            logger.warning("Shipment snapshot failed for project %s: %s", pid, e)

        # 退货 + 退货率基数（同一时间段内的销售量）
        try:
            ret = digital_display_service._build_return_snapshot(
                db, pid, normalized_country, period_start, today
            )
            total_returns += ret["total_returns"]
            total_return_qty += ret["total_quantity"]
            if ret["top_reason"]:
                return_reason_counter[ret["top_reason"]] += ret["total_returns"]
        except Exception as e:
            logger.warning("Return snapshot failed for project %s: %s", pid, e)

        # 退货率计算基数（复用 _build_return_snapshot 同样的查询条件）
        try:
            sales_qty_row = (
                db.query(func.coalesce(func.sum(AnalysisSalesOrderRow.quantity), 0))
                .join(
                    AnalysisSourceFile,
                    AnalysisSourceFile.id == AnalysisSalesOrderRow.source_file_id,
                )
                .filter(
                    AnalysisSourceFile.project_id == pid,
                    AnalysisSourceFile.country == normalized_country,
                    AnalysisSourceFile.report_type == "sales_report",
                    AnalysisSourceFile.is_current == True,
                    AnalysisSalesOrderRow.is_counted_sales == True,
                    AnalysisSalesOrderRow.purchase_date_pt >= period_start,
                    AnalysisSalesOrderRow.purchase_date_pt <= today,
                )
                .scalar() or 0
            )
            total_sales_qty_for_return += float(sales_qty_row)
        except Exception as e:
            logger.warning("Sales qty query failed for project %s: %s", pid, e)

        # 广告
        try:
            ad = digital_display_service._build_ad_snapshot(
                db, pid, normalized_country, period_start, today
            )
            total_ad_spend += ad["period_spend"]
            total_ad_sales += ad["period_sales"]
            total_ad_impressions += ad["period_impressions"]
            total_ad_clicks += ad["period_clicks"]
            total_ad_orders += ad["period_orders"]
        except Exception as e:
            logger.warning("Ad snapshot failed for project %s: %s", pid, e)

    # SKU 销售明细（使用完整时间范围）
    sku_detail = _build_sku_sales_detail(db, valid_ids, normalized_country, period_start, today)

    # 4. 计算派生指标（单日环比：今日 vs 昨日）
    qty_change_pct, qty_change_type = _safe_pct_change(
        float(total_today_qty), float(total_yesterday_qty)
    )
    amount_change_pct, amount_change_type = _safe_pct_change(
        total_today_amount, total_yesterday_amount
    )

    return_rate = round(
        total_return_qty / total_sales_qty_for_return * 100, 2
    ) if total_sales_qty_for_return > 0 else 0.0

    period_roas = round(total_ad_sales / total_ad_spend, 2) if total_ad_spend > 0 else 0.0
    period_acos = round(total_ad_spend / total_ad_sales * 100, 2) if total_ad_sales > 0 else 0.0
    period_ctr = round(total_ad_clicks / total_ad_impressions * 100, 2) if total_ad_impressions > 0 else 0.0

    top_reason = return_reason_counter.most_common(1)[0][0] if return_reason_counter else None

    sales_trend = [
        {
            "date": d,
            "order_qty": int(trend_map[d]["order_qty"]),
            "sales_amount": trend_map[d]["sales_amount"],
        }
        for d in sorted(trend_map.keys())
    ]

    return {
        "project_ids": valid_ids,
        "project_names": valid_names,
        "country": normalized_country,
        "days": days,
        "server_time": str(today),
        "sales": {
            "today_order_qty": total_today_qty,
            "today_sales_amount": round_money(Decimal(str(total_today_amount))),
            "yesterday_order_qty": total_yesterday_qty,
            "yesterday_sales_amount": round_money(Decimal(str(total_yesterday_amount))),
            "prev_order_qty": total_prev_qty,
            "prev_sales_amount": round_money(Decimal(str(total_prev_amount))),
            "order_qty_change_pct": qty_change_pct,
            "sales_change_pct": amount_change_pct,
            "change_type_order_qty": qty_change_type,
            "change_type_sales": amount_change_type,
        },
        "sales_trend": sales_trend,
        "inventory": {
            "sku_count": total_sku_count,
            "out_of_stock_count": total_oos_count,
            "available_qty": total_available_qty,
        },
        "shipments": {
            "in_transit_count": total_in_transit_count,
            "in_transit_qty": total_in_transit_qty,
        },
        "returns": {
            "total_returns": total_returns,
            "total_quantity": total_return_qty,
            "return_rate": return_rate,
            "top_reason": top_reason,
        },
        "ads": {
            "period_spend": round(total_ad_spend, 2),
            "period_sales": round(total_ad_sales, 2),
            "period_roas": period_roas,
            "period_acos": period_acos,
            "period_ctr": period_ctr,
            "period_impressions": total_ad_impressions,
            "period_clicks": total_ad_clicks,
            "period_orders": total_ad_orders,
        },
        "sku_sales_detail": sku_detail,
    }


def _empty_response(country: str, days: int) -> dict:
    today = date.today()
    return {
        "project_ids": [],
        "project_names": [],
        "country": country.strip() or "US",
        "days": days,
        "server_time": str(today),
        "sales": {
            "today_order_qty": 0,
            "today_sales_amount": 0.0,
            "prev_order_qty": 0,
            "prev_sales_amount": 0.0,
            "order_qty_change_pct": 0.0,
            "sales_change_pct": 0.0,
            "change_type_order_qty": "neutral",
            "change_type_sales": "neutral",
        },
        "sales_trend": [
            {
                "date": (today - timedelta(days=days - 1 - i)).isoformat(),
                "order_qty": 0,
                "sales_amount": 0.0,
            }
            for i in range(days)
        ],
        "inventory": {
            "sku_count": 0,
            "out_of_stock_count": 0,
            "available_qty": 0,
        },
        "shipments": {
            "in_transit_count": 0,
            "in_transit_qty": 0,
        },
        "returns": {
            "total_returns": 0,
            "total_quantity": 0,
            "return_rate": 0.0,
            "top_reason": None,
        },
        "ads": {
            "period_spend": 0.0,
            "period_sales": 0.0,
            "period_roas": 0.0,
            "period_acos": 0.0,
            "period_ctr": 0.0,
            "period_impressions": 0,
            "period_clicks": 0,
            "period_orders": 0,
        },
        "sku_sales_detail": [],
    }


# ─── SKU sales detail ──────────────────────────────────────────────────────────

def _build_sku_sales_detail(
    db: Session,
    project_ids: list[int],
    country: str,
    start_date: date,
    end_date: date,
) -> list[dict]:
    """查询指定日期范围内各 SKU 的销售数量和金额，过滤销售额为0"""
    if not project_ids:
        return []

    # 查询日期范围内各 SKU 的销售汇总
    sku_sales_rows = (
        db.query(
            AnalysisSalesOrderRow.sku,
            func.sum(AnalysisSalesOrderRow.quantity).label("total_qty"),
            func.sum(
                func.coalesce(AnalysisSalesOrderRow.item_price, 0) +
                func.coalesce(AnalysisSalesOrderRow.shipping_price, 0)
            ).label("total_amount"),
        )
        .join(
            AnalysisSourceFile,
            AnalysisSourceFile.id == AnalysisSalesOrderRow.source_file_id,
        )
        .filter(
            AnalysisSourceFile.project_id.in_(project_ids),
            AnalysisSourceFile.country == country,
            AnalysisSourceFile.report_type == "sales_report",
            AnalysisSourceFile.is_current == True,
            AnalysisSalesOrderRow.is_counted_sales == True,
            AnalysisSalesOrderRow.purchase_date_pt >= start_date,
            AnalysisSalesOrderRow.purchase_date_pt <= end_date,
            AnalysisSalesOrderRow.sku.isnot(None),
            AnalysisSalesOrderRow.sku != "",
        )
        .group_by(AnalysisSalesOrderRow.sku)
        .having(func.sum(
            func.coalesce(AnalysisSalesOrderRow.item_price, 0) +
            func.coalesce(AnalysisSalesOrderRow.shipping_price, 0)
        ) > 0)
        .order_by(func.sum(
            func.coalesce(AnalysisSalesOrderRow.item_price, 0) +
            func.coalesce(AnalysisSalesOrderRow.shipping_price, 0)
        ).desc())
        .limit(50)  # 限制最多50条
        .all()
    )

    if not sku_sales_rows:
        return []

    # 收集所有 SKU
    sku_list = [row.sku for row in sku_sales_rows]
    project_id = project_ids[0]  # 取第一个项目作为查询基准

    # 查询 product_costs 获取品名
    product_name_map: dict[str, str | None] = {}
    name_rows = (
        db.query(SkuRecord.sku, SkuRecord.product_name)
        .filter(
            SkuRecord.project_id.in_(project_ids),
            SkuRecord.sku.in_(sku_list),
            SkuRecord.country == country,
        )
        .all()
    )
    for row in name_rows:
        product_name_map[row.sku] = row.product_name

    result = []
    for row in sku_sales_rows:
        result.append({
            "sku": row.sku,
            "product_name": product_name_map.get(row.sku),
            "quantity": int(row.total_qty or 0),
            "sales_amount": round_money(Decimal(str(row.total_amount or 0))),
        })

    return result