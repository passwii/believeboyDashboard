"""Dashboard KPI 总览聚合服务 — 批量查询优化版

核心改动：
- 将逐项目的 6 个 snapshot 调用（14×29=406 次查询）替换为 7 次批量 SQL 查询
- 原 _build_* 函数保留在 digital_display_service.py 不变，其他模块继续使用
- 返回值结构与 DashboardOverviewResponse 完全兼容
"""

from __future__ import annotations

import logging
from collections import Counter
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import bindparam, func, text
from sqlalchemy.orm import Session

from app.models import (
    AnalysisSalesOrderRow,
    AnalysisSourceFile,
    SkuRecord,
)
from app.constants.return_translations import translate_return_field
from app.utils.country import normalize_country
from app.utils.math_utils import round_money
from app.services import project_service

logger = logging.getLogger(__name__)


def _safe_pct_change(current: float, prev: float) -> tuple[float, str]:
    if prev == 0:
        return 0.0, "neutral"
    change = ((current - prev) / prev) * 100
    if abs(change) < 0.5:
        return round(change, 2), "neutral"
    return round(change, 2), "up" if change > 0 else "down"


def _safe_rate(numerator: float, denominator: float) -> float:
    if denominator <= 0:
        return 0.0
    return round(numerator / denominator * 100, 2)


# ─── 批量查询函数 ─────────────────────────────────────────────────────────────


def _bulk_sales_snapshot(
    db: Session,
    project_ids: list[int],
    country: str,
    today: date,
    days: int,
) -> tuple[dict[int, dict], dict[int, float]]:
    """批量查询所有项目的销售数据。

    返回：
        (per_project_snapshot, per_project_period_sales_qty)
        per_project_period_sales_qty 用于退货率计算基数。
    """
    if not project_ids:
        return {}, {}

    period_start = today - timedelta(days=days - 1)
    yesterday = today - timedelta(days=1)
    prev_start = yesterday - timedelta(days=days - 1)

    pids = tuple(project_ids)

    # ── 查询 1：按项目 + 日期分组的销售行（覆盖 prev_start ~ today）──
    sales_rows = db.execute(
        text("""
            SELECT
                sf.project_id,
                sor.purchase_date_pt AS d,
                COALESCE(SUM(sor.quantity), 0) AS qty,
                COALESCE(SUM(COALESCE(sor.item_price, 0) + COALESCE(sor.shipping_price, 0)), 0) AS amount
            FROM analysis_sales_order_rows sor
            JOIN analysis_source_files sf ON sf.id = sor.source_file_id
            WHERE sf.project_id IN :pids
              AND sf.country = :country
              AND sf.report_type = 'sales_report'
              AND sf.is_current = true
              AND sor.is_counted_sales = true
              AND sor.purchase_date_pt >= :prev_start
              AND sor.purchase_date_pt <= :today
            GROUP BY sf.project_id, sor.purchase_date_pt
        """).bindparams(bindparam("pids", expanding=True)),
        {"pids": pids, "country": country, "prev_start": prev_start, "today": today},
    ).fetchall()

    # ── 查询 2：业务报表 sessions/ordered_sales_amount（不分日期）──
    biz_rows = db.execute(
        text("""
            SELECT
                sf.project_id,
                COALESCE(SUM(br.sessions), 0) AS sessions,
                COALESCE(SUM(br.ordered_sales_amount), 0) AS sales
            FROM analysis_business_rows br
            JOIN analysis_source_files sf ON sf.id = br.source_file_id
            WHERE sf.project_id IN :pids
              AND sf.country = :country
              AND sf.report_type = 'business_report'
              AND sf.is_current = true
            GROUP BY sf.project_id
        """).bindparams(bindparam("pids", expanding=True)),
        {"pids": pids, "country": country},
    ).fetchall()

    # ── Python 侧组装 ──
    # 初始化每个项目的日期 -> {qty, amount}
    date_range: list[date] = [today - timedelta(days=offset) for offset in range(days)]
    project_day: dict[int, dict[str, dict[str, float]]] = {}
    for pid in project_ids:
        day_map: dict[str, dict[str, float]] = {}
        for d in date_range:
            day_map[d.isoformat()] = {"qty": 0, "amount": 0.0}
        project_day[pid] = day_map

    for row in sales_rows:
        pid = int(row.project_id)
        d = row.d
        if pid in project_day and hasattr(d, "isoformat"):
            key = d.isoformat()
            if key in project_day[pid]:
                project_day[pid][key] = {
                    "qty": int(row.qty or 0),
                    "amount": float(row.amount or 0),
                }

    # 业务报表 sessions（按项目聚合，不分日期）
    biz_map: dict[int, dict] = {}
    for row in biz_rows:
        pid = int(row.project_id)
        biz_map[pid] = {"sessions": int(row.sessions or 0), "sales": float(row.sales or 0)}

    # 组装各项目的 snapshot
    result: dict[int, dict] = {}
    period_sales_qty: dict[int, float] = {}

    for pid in project_ids:
        day_map = project_day.get(pid, {})

        today_key = today.isoformat()
        td = day_map.get(today_key, {"qty": 0, "amount": 0.0})
        today_qty = int(td["qty"])
        today_amount = float(td["amount"])

        yesterday_key = yesterday.isoformat()
        yd = day_map.get(yesterday_key, {"qty": 0, "amount": 0.0})
        yesterday_qty = int(yd["qty"])
        yesterday_amount = float(yd["amount"])

        # prev period（prev_start ~ yesterday）
        prev_qty = 0
        prev_amount = 0.0
        for d in (prev_start + timedelta(days=i) for i in range(days)):
            pk = d.isoformat()
            if pk in day_map:
                prev_qty += int(day_map[pk]["qty"])
                prev_amount += float(day_map[pk]["amount"])

        # period sales qty（period_start ~ today，用于退货率基数）
        psq = 0.0
        for d in (period_start + timedelta(days=i) for i in range(days)):
            pk = d.isoformat()
            if pk in day_map:
                psq += float(day_map[pk]["qty"])
        period_sales_qty[pid] = psq

        # trend
        trend_rows_data = []
        for d in date_range:
            tk = d.isoformat()
            dd = day_map.get(tk, {"qty": 0, "amount": 0.0})
            trend_rows_data.append({
                "date": tk,
                "order_qty": int(dd["qty"]),
                "sales_amount": round_money(Decimal(str(dd["amount"]))),
            })

        biz = biz_map.get(pid, {"sessions": 0, "sales": 0.0})

        result[pid] = {
            "today_order_qty": today_qty,
            "today_sales_amount": round_money(Decimal(str(today_amount))),
            "yesterday_order_qty": yesterday_qty,
            "yesterday_sales_amount": round_money(Decimal(str(yesterday_amount))),
            "prev_order_qty": prev_qty,
            "prev_sales_amount": round_money(Decimal(str(prev_amount))),
            "trend": trend_rows_data,
        }

    return result, period_sales_qty


def _bulk_inventory_snapshot(
    db: Session,
    project_ids: list[int],
    country: str,
) -> dict[int, dict]:
    """批量查询所有项目的库存数据。"""
    if not project_ids:
        return {}

    pids = tuple(project_ids)

    # 查询 1：每个项目最新的库存 source_file_id
    latest_rows = db.execute(
        text("""
            SELECT DISTINCT ON (project_id)
                project_id, id AS source_file_id
            FROM analysis_source_files
            WHERE project_id IN :pids
              AND country = :country
              AND report_type = 'inventory_report'
              AND is_current = true
            ORDER BY project_id, report_date DESC NULLS LAST, snapshot_at DESC NULLS LAST
        """).bindparams(bindparam("pids", expanding=True)),
        {"pids": pids, "country": country},
    ).fetchall()

    if not latest_rows:
        return {pid: {"sku_count": 0, "out_of_stock_count": 0, "available_qty": 0} for pid in project_ids}

    # project_id -> source_file_id
    latest_map: dict[int, int] = {}
    for row in latest_rows:
        latest_map[int(row.project_id)] = int(row.source_file_id)

    source_ids = tuple(latest_map.values())

    # 查询 2：按 source_file_id 聚合库存统计
    inv_rows = db.execute(
        text("""
            SELECT
                source_file_id,
                COUNT(DISTINCT sku) AS sku_count,
                COALESCE(SUM(available_qty), 0) AS total_qty,
                COUNT(DISTINCT CASE WHEN available_qty <= 0 THEN sku END) AS oos_count
            FROM inventory_snapshot_rows
            WHERE source_file_id IN :sids
            GROUP BY source_file_id
        """).bindparams(bindparam("sids", expanding=True)),
        {"sids": source_ids},
    ).fetchall()

    # source_file_id -> stats
    inv_map: dict[int, dict] = {}
    for row in inv_rows:
        sid = int(row.source_file_id)
        inv_map[sid] = {
            "sku_count": int(row.sku_count or 0),
            "out_of_stock_count": int(row.oos_count or 0),
            "available_qty": int(row.total_qty or 0),
        }

    # 组装
    result: dict[int, dict] = {}
    empty = {"sku_count": 0, "out_of_stock_count": 0, "available_qty": 0}
    for pid in project_ids:
        sid = latest_map.get(pid)
        result[pid] = inv_map.get(sid, empty) if sid else empty

    return result


def _bulk_shipment_snapshot(
    db: Session,
    project_ids: list[int],
    country: str,
) -> dict[int, dict]:
    """批量查询所有项目的发货在途数据。"""
    if not project_ids:
        return {}

    pids = tuple(project_ids)
    nc = normalize_country(country)

    rows = db.execute(
        text("""
            SELECT
                ss.project_id,
                COUNT(ss.id) AS in_transit_count,
                COALESCE(SUM(ssi.total_qty), 0) AS in_transit_qty
            FROM shipment_schedules ss
            LEFT JOIN (
                SELECT shipment_schedule_id, SUM(quantity) AS total_qty
                FROM shipment_schedule_items
                GROUP BY shipment_schedule_id
            ) ssi ON ssi.shipment_schedule_id = ss.id
            WHERE ss.project_id IN :pids
              AND ss.country = :country
              AND ss.shipment_status = 'in_transit'
            GROUP BY ss.project_id
        """).bindparams(bindparam("pids", expanding=True)),
        {"pids": pids, "country": nc},
    ).fetchall()

    result: dict[int, dict] = {}
    for row in rows:
        pid = int(row.project_id)
        result[pid] = {
            "in_transit_count": int(row.in_transit_count or 0),
            "in_transit_qty": int(row.in_transit_qty or 0),
        }

    # 补充没有在途数据的项目
    for pid in project_ids:
        if pid not in result:
            result[pid] = {"in_transit_count": 0, "in_transit_qty": 0}

    return result


def _bulk_return_snapshot(
    db: Session,
    project_ids: list[int],
    country: str,
    period_start: date,
    today: date,
    period_sales_qty: dict[int, float],
) -> dict[int, dict]:
    """批量查询所有项目的退货数据。"""
    if not project_ids:
        return {}

    pids = tuple(project_ids)
    nc = normalize_country(country)

    # 按 project_id + reason 分组，统计退货数和退货数量
    ret_rows = db.execute(
        text("""
            SELECT
                sf.project_id,
                rr.reason,
                COUNT(rr.id) AS cnt,
                COALESCE(SUM(rr.quantity), 0) AS qty
            FROM analysis_return_rows rr
            JOIN analysis_source_files sf ON sf.id = rr.source_file_id
            WHERE sf.project_id IN :pids
              AND sf.country = :country
              AND sf.report_type = 'return_report'
              AND sf.is_current = true
              AND rr.return_date >= :period_start
              AND rr.return_date <= :today
            GROUP BY sf.project_id, rr.reason
        """).bindparams(bindparam("pids", expanding=True)),
        {"pids": pids, "country": nc, "period_start": period_start, "today": today},
    ).fetchall()

    # Python 侧聚合：每个项目总计 + top reason
    project_returns: dict[int, dict] = {}
    for pid in project_ids:
        project_returns[pid] = {
            "total_returns": 0,
            "total_quantity": 0,
            "reason_counter": Counter(),
        }

    for row in ret_rows:
        pid = int(row.project_id)
        if pid in project_returns:
            cnt = int(row.cnt or 0)
            qty = int(row.qty or 0)
            reason = row.reason or "OTHER"
            project_returns[pid]["total_returns"] += cnt
            project_returns[pid]["total_quantity"] += qty
            project_returns[pid]["reason_counter"][reason] += cnt

    result: dict[int, dict] = {}
    for pid in project_ids:
        pr = project_returns[pid]
        reason_counter: Counter[str] = pr["reason_counter"]

        sales_qty = period_sales_qty.get(pid, 0.0)
        return_rate = _safe_rate(float(pr["total_quantity"]), sales_qty)

        result[pid] = {
            "total_returns": pr["total_returns"],
            "total_quantity": pr["total_quantity"],
            "return_rate": return_rate,
            # _raw_reason_counter 用于主函数全局汇总 top_reason
            "_raw_reason_counter": reason_counter,
        }

    return result


def _bulk_ad_snapshot(
    db: Session,
    project_ids: list[int],
    country: str,
    period_start: date,
    today: date,
) -> dict[int, dict]:
    """批量查询所有项目的广告数据。"""
    if not project_ids:
        return {}

    pids = tuple(project_ids)
    nc = normalize_country(country)

    rows = db.execute(
        text("""
            SELECT
                af.project_id,
                COALESCE(SUM(apr.spend), 0) AS spend,
                COALESCE(SUM(apr.sales_7d), 0) AS sales,
                COALESCE(SUM(apr.clicks), 0) AS clicks,
                COALESCE(SUM(apr.impressions), 0) AS impressions,
                COALESCE(SUM(apr.orders_7d), 0) AS orders
            FROM ad_upload_promoted_product_rows apr
            JOIN ad_upload_files af ON af.id = apr.source_file_id
            WHERE af.project_id IN :pids
              AND af.country = :country
              AND af.report_type = 'ad_promoted_product_report'
              AND af.is_current = true
              AND af.period_end_date >= :period_start
              AND af.period_end_date <= :today
              AND apr.scope_status = 'included_product'
            GROUP BY af.project_id
        """).bindparams(bindparam("pids", expanding=True)),
        {"pids": pids, "country": nc, "period_start": period_start, "today": today},
    ).fetchall()

    result: dict[int, dict] = {}
    for row in rows:
        pid = int(row.project_id)
        spend = float(row.spend or 0)
        sales = float(row.sales or 0)
        clicks = int(row.clicks or 0)
        impressions = int(row.impressions or 0)
        orders = int(row.orders or 0)

        roas = round(sales / spend, 2) if spend > 0 else 0.0
        acos = round(spend / sales * 100, 2) if sales > 0 else 0.0
        ctr = round(clicks / impressions * 100, 2) if impressions > 0 else 0.0

        result[pid] = {
            "period_spend": round(spend, 2),
            "period_sales": round(sales, 2),
            "period_roas": roas,
            "period_acos": acos,
            "period_ctr": ctr,
            "period_impressions": impressions,
            "period_clicks": clicks,
            "period_orders": orders,
        }

    # 补充没有广告数据的项目
    for pid in project_ids:
        if pid not in result:
            result[pid] = {
                "period_spend": 0.0,
                "period_sales": 0.0,
                "period_roas": 0.0,
                "period_acos": 0.0,
                "period_ctr": 0.0,
                "period_impressions": 0,
                "period_clicks": 0,
                "period_orders": 0,
            }

    return result


# ─── 主函数 ────────────────────────────────────────────────────────────────────


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

    使用批量 SQL 查询替代逐项目循环，将 ~406 次查询降到 ~7 次。

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

    # 2. 批量查询（固定 ~7 次 SQL，不随项目数增长）
    sales_data, period_sales_qty = _bulk_sales_snapshot(
        db, valid_ids, normalized_country, today, days
    )
    inventory_data = _bulk_inventory_snapshot(db, valid_ids, normalized_country)
    shipment_data = _bulk_shipment_snapshot(db, valid_ids, normalized_country)
    ad_data = _bulk_ad_snapshot(db, valid_ids, normalized_country, period_start, today)
    return_data = _bulk_return_snapshot(
        db, valid_ids, normalized_country, period_start, today, period_sales_qty
    )

    # 3. Python 侧累加（遍历项目，无额外 DB 查询）
    total_today_qty = 0
    total_today_amount = 0.0
    total_yesterday_qty = 0
    total_yesterday_amount = 0.0
    total_prev_qty = 0
    total_prev_amount = 0.0

    trend_map: dict[str, dict[str, float | int]] = {}
    for offset in range(days):
        d = today - timedelta(days=offset)
        trend_map[d.isoformat()] = {"order_qty": 0, "sales_amount": 0.0}

    total_sku_count = 0
    total_oos_count = 0
    total_available_qty = 0

    total_in_transit_count = 0
    total_in_transit_qty = 0

    total_returns = 0
    total_return_qty = 0
    total_sales_qty_for_return = 0.0

    total_ad_spend = 0.0
    total_ad_sales = 0.0
    total_ad_impressions = 0
    total_ad_clicks = 0
    total_ad_orders = 0

    # 全局退货原因统计（用于确定 top_reason）
    global_return_reason_counter: Counter[str] = Counter()

    for pid in valid_ids:
        # 销售
        sales = sales_data.get(pid, {})
        total_today_qty += sales.get("today_order_qty", 0)
        total_today_amount += sales.get("today_sales_amount", 0.0)
        total_yesterday_qty += sales.get("yesterday_order_qty", 0)
        total_yesterday_amount += sales.get("yesterday_sales_amount", 0.0)
        total_prev_qty += sales.get("prev_order_qty", 0)
        total_prev_amount += sales.get("prev_sales_amount", 0.0)
        for item in sales.get("trend", []):
            date_str = item["date"]
            if date_str in trend_map:
                trend_map[date_str]["order_qty"] += item["order_qty"]
                trend_map[date_str]["sales_amount"] += item["sales_amount"]

        # 库存
        inv = inventory_data.get(pid, {})
        total_sku_count += inv.get("sku_count", 0)
        total_oos_count += inv.get("out_of_stock_count", 0)
        total_available_qty += inv.get("available_qty", 0)

        # 发货
        ship = shipment_data.get(pid, {})
        total_in_transit_count += ship.get("in_transit_count", 0)
        total_in_transit_qty += ship.get("in_transit_qty", 0)

        # 退货
        ret = return_data.get(pid, {})
        total_returns += ret.get("total_returns", 0)
        total_return_qty += ret.get("total_quantity", 0)
        total_sales_qty_for_return += period_sales_qty.get(pid, 0.0)

        # 退货率：累加所有 reason 的计数（而非仅 top_reason）
        raw_counter = ret.get("_raw_reason_counter")
        if raw_counter:
            global_return_reason_counter += raw_counter

        # 广告
        ad = ad_data.get(pid, {})
        total_ad_spend += ad.get("period_spend", 0.0)
        total_ad_sales += ad.get("period_sales", 0.0)
        total_ad_impressions += ad.get("period_impressions", 0)
        total_ad_clicks += ad.get("period_clicks", 0)
        total_ad_orders += ad.get("period_orders", 0)

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

    top_reason_raw = global_return_reason_counter.most_common(1)[0][0] if global_return_reason_counter else None
    top_reason = translate_return_field("reason", top_reason_raw) if top_reason_raw else None

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

    _total_amount_expr = func.coalesce(
        func.sum(
            func.coalesce(AnalysisSalesOrderRow.item_price, 0) +
            func.coalesce(AnalysisSalesOrderRow.shipping_price, 0)
        ), 0
    )

    # 查询日期范围内各 SKU 的销售汇总
    sku_sales_rows = (
        db.query(
            AnalysisSalesOrderRow.sku,
            func.coalesce(func.sum(AnalysisSalesOrderRow.quantity), 0).label("total_qty"),
            _total_amount_expr.label("total_amount"),
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
        .having(_total_amount_expr > 0)
        .order_by(_total_amount_expr.desc())
        .limit(50)
        .all()
    )

    if not sku_sales_rows:
        return []

    # 收集所有 SKU
    sku_list = [row.sku for row in sku_sales_rows]

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
