"""Build report email data from local report queries."""

from __future__ import annotations

import logging
from datetime import date, timedelta
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models import AdUploadFile, AdUploadPromotedProductRow, AnalysisReturnRow, AnalysisSalesOrderRow, AnalysisSourceFile, InventorySnapshotRow
from app.models.project import Project
from app.models.shipment_schedule import ShipmentSchedule, ShipmentScheduleItem
from app.models.sku_info import SkuRecord
from app.services.scheduled_report.ai_timeout import get_ai_timeout_sec
from app.services.scheduled_report.context_helpers import (
    fetch_and_format_sku_factory_info,
    fetch_multi_project_context,
)
from app.utils.country import get_today_for_country, normalize_country

logger = logging.getLogger(__name__)


def _get_report_anchor_date(country: str) -> date:
    """计算报告的数据锚定日期 — 最近一个数据完整的日期。

    取 min(目标国家当天, 服务器昨天)：
      情况1: 中国 5/22 上午  → US PT 5/21 (晚间)  → min(5/21, 5/21) = 5/21 ✅
      情况2: 中国 5/22 下午  → US PT 5/22 (凌晨)  → min(5/22, 5/21) = 5/21 ✅
    无论何时生成报告，都不会拉到刚开始、数据还没累积的那一天。
    """
    country_today = get_today_for_country(country)
    server_yesterday = date.today() - timedelta(days=1)
    return min(country_today, server_yesterday)


def _safe_pct_change(current: float, previous: float) -> tuple[float, str]:
    if previous == 0:
        return 0.0, "neutral"
    change = ((current - previous) / previous) * 100
    if abs(change) < 0.5:
        return round(change, 2), "neutral"
    return round(change, 2), "up" if change > 0 else "down"


def _query_project_names(db: Session, project_ids: list[int] | None) -> list[str]:
    if not project_ids:
        return []

    rows = (
        db.query(Project.id, Project.project_name)
        .filter(Project.id.in_(project_ids))
        .order_by(Project.id)
        .all()
    )
    return [row.project_name for row in rows if row.project_name]


def _query_sales_snapshot(
    db: Session,
    project_ids: list[int] | None,
    country: str,
    start_date: date,
    end_date: date,
) -> tuple[dict[str, Any], list[dict[str, Any]], int]:
    """查询近 7 天销售趋势、锚定日销售，以及前 7 天对比量。"""
    try:
        trend_map: dict[date, dict[str, float | int]] = {}
        current = start_date
        while current <= end_date:
            trend_map[current] = {"order_qty": 0, "sales_amount": 0.0}
            current += timedelta(days=1)

        amount_expr = func.coalesce(AnalysisSalesOrderRow.item_price, 0) + func.coalesce(
            AnalysisSalesOrderRow.shipping_price, 0
        )
        rows = (
            db.query(
                AnalysisSalesOrderRow.purchase_date_pt.label("purchase_date"),
                func.coalesce(func.sum(AnalysisSalesOrderRow.quantity), 0).label("qty"),
                func.coalesce(func.sum(amount_expr), 0).label("amount"),
            )
            .join(AnalysisSourceFile, AnalysisSourceFile.id == AnalysisSalesOrderRow.source_file_id)
            .filter(
                AnalysisSourceFile.country == country,
                AnalysisSourceFile.report_type == "sales_report",
                AnalysisSourceFile.is_current == True,  # noqa: E712
                AnalysisSalesOrderRow.is_counted_sales == True,  # noqa: E712
                AnalysisSalesOrderRow.purchase_date_pt >= start_date,
                AnalysisSalesOrderRow.purchase_date_pt <= end_date,
            )
        )
        if project_ids:
            rows = rows.filter(AnalysisSourceFile.project_id.in_(project_ids))

        for row in rows.group_by(AnalysisSalesOrderRow.purchase_date_pt).all():
            purchase_date = row.purchase_date
            if purchase_date in trend_map:
                trend_map[purchase_date] = {
                    "order_qty": int(row.qty or 0),
                    "sales_amount": float(row.amount or 0),
                }

        trend_days = [
            {"date": current.isoformat(), **trend_map[current]}
            for current in sorted(trend_map)
        ]

        yesterday = end_date - timedelta(days=1)
        prev_start = yesterday - timedelta(days=6)
        prev_sales = _query_period_sales(db, project_ids, country, prev_start, yesterday)

        today_qty = int(trend_map[end_date]["order_qty"])
        today_amount = float(trend_map[end_date]["sales_amount"])
        yesterday_qty = int(trend_map[yesterday]["order_qty"])
        yesterday_amount = float(trend_map[yesterday]["sales_amount"])
        qty_change_pct, qty_change_type = _safe_pct_change(today_qty, yesterday_qty)
        amount_change_pct, amount_change_type = _safe_pct_change(today_amount, yesterday_amount)

        sales = {
            "today_order_qty": today_qty,
            "today_sales_amount": today_amount,
            "yesterday_order_qty": yesterday_qty,
            "yesterday_sales_amount": yesterday_amount,
            "prev_order_qty": int(prev_sales.get("week_qty", 0)),
            "prev_sales_amount": float(prev_sales.get("week_amount", 0.0)),
            "order_qty_change_pct": qty_change_pct,
            "sales_change_pct": amount_change_pct,
            "change_type_order_qty": qty_change_type,
            "change_type_sales": amount_change_type,
        }
        return sales, trend_days, sum(int(day["order_qty"]) for day in trend_days)
    except Exception as e:
        logger.warning("Failed to query sales snapshot: %s", e)
        empty_trend = [
            {
                "date": (start_date + timedelta(days=offset)).isoformat(),
                "order_qty": 0,
                "sales_amount": 0.0,
            }
            for offset in range((end_date - start_date).days + 1)
        ]
        return {
            "today_order_qty": 0,
            "today_sales_amount": 0.0,
            "yesterday_order_qty": 0,
            "yesterday_sales_amount": 0.0,
            "prev_order_qty": 0,
            "prev_sales_amount": 0.0,
            "order_qty_change_pct": 0.0,
            "sales_change_pct": 0.0,
            "change_type_order_qty": "neutral",
            "change_type_sales": "neutral",
        }, empty_trend, 0


def _query_inventory_summary(db: Session, project_ids: list[int] | None, country: str) -> dict[str, Any]:
    try:
        query = (
            db.query(
                InventorySnapshotRow.sku,
                InventorySnapshotRow.available_qty,
                InventorySnapshotRow.stock_status,
            )
            .join(AnalysisSourceFile, AnalysisSourceFile.id == InventorySnapshotRow.source_file_id)
            .filter(
                AnalysisSourceFile.country == country,
                AnalysisSourceFile.report_type == "inventory_report",
                AnalysisSourceFile.is_current == True,  # noqa: E712
            )
        )
        if project_ids:
            query = query.filter(AnalysisSourceFile.project_id.in_(project_ids))

        rows = query.all()
        return {
            "sku_count": len(rows),
            "out_of_stock_count": sum(
                1 for row in rows if (row.available_qty or 0) <= 0 or row.stock_status == "out_of_stock"
            ),
            "available_qty": sum(int(row.available_qty or 0) for row in rows),
        }
    except Exception as e:
        logger.warning("Failed to query inventory summary: %s", e)
        return {"sku_count": 0, "out_of_stock_count": 0, "available_qty": 0}


def _query_shipment_snapshot(db: Session, project_ids: list[int] | None, country: str) -> dict[str, Any]:
    try:
        normalized_country = normalize_country(country)
        query = (
            db.query(
                func.count(func.distinct(ShipmentSchedule.id)).label("in_transit_count"),
                func.coalesce(func.sum(ShipmentScheduleItem.quantity), 0).label("in_transit_qty"),
            )
            .join(
                ShipmentScheduleItem,
                ShipmentScheduleItem.shipment_schedule_id == ShipmentSchedule.id,
                isouter=True,
            )
            .filter(
                ShipmentSchedule.country == normalized_country,
                ShipmentSchedule.shipment_status == "in_transit",
            )
        )
        if project_ids:
            query = query.filter(ShipmentSchedule.project_id.in_(project_ids))

        row = query.first()
        return {
            "in_transit_count": int(row.in_transit_count or 0) if row else 0,
            "in_transit_qty": int(row.in_transit_qty or 0) if row else 0,
        }
    except Exception as e:
        logger.warning("Failed to query shipment snapshot: %s", e)
        return {"in_transit_count": 0, "in_transit_qty": 0}


def _query_ads_period(
    db: Session,
    project_ids: list[int] | None,
    country: str,
    start_date: date,
    end_date: date,
) -> dict[str, Any]:
    try:
        query = (
            db.query(
                func.coalesce(func.sum(AdUploadPromotedProductRow.spend), 0).label("spend"),
                func.coalesce(func.sum(AdUploadPromotedProductRow.sales_7d), 0).label("sales"),
                func.coalesce(func.sum(AdUploadPromotedProductRow.clicks), 0).label("clicks"),
                func.coalesce(func.sum(AdUploadPromotedProductRow.impressions), 0).label("impressions"),
                func.coalesce(func.sum(AdUploadPromotedProductRow.orders_7d), 0).label("orders"),
            )
            .join(
                AdUploadFile,
                AdUploadFile.id == AdUploadPromotedProductRow.source_file_id,
            )
            .filter(
                AdUploadFile.country == country,
                AdUploadFile.report_type == "ad_promoted_product_report",
                AdUploadFile.is_current == True,  # noqa: E712
                AdUploadFile.period_end_date >= start_date,
                AdUploadFile.period_end_date <= end_date,
                AdUploadPromotedProductRow.scope_status == "included_product",
            )
        )
        if project_ids:
            query = query.filter(AdUploadFile.project_id.in_(project_ids))

        row = query.first()
        spend = float(row.spend or 0) if row else 0
        sales = float(row.sales or 0) if row else 0
        clicks = int(row.clicks or 0) if row else 0
        impressions = int(row.impressions or 0) if row else 0
        orders = int(row.orders or 0) if row else 0

        roas = round(sales / spend, 2) if spend > 0 else 0.0
        acos = round(spend / sales * 100, 2) if sales > 0 else 0.0
        ctr = round(clicks / impressions * 100, 2) if impressions > 0 else 0.0

        return {
            "spend": round(spend, 2),
            "sales": round(sales, 2),
            "roas": roas,
            "acos": acos,
            "ctr": ctr,
            "orders": orders,
        }
    except Exception as e:
        logger.warning("Failed to query period ads for %s ~ %s: %s", start_date, end_date, e)
        return {
            "spend": 0.0,
            "sales": 0.0,
            "roas": 0.0,
            "acos": 0.0,
            "ctr": 0.0,
            "orders": 0,
        }


def build_report_email_data(
    db: Session,
    project_ids: list[int] | None,
    country: str,
    frequency: str = "daily",
    ai_model: str | None = None,
    reference_date: date | None = None,
    stage_callback=None,
    ai_timeout: float | None = None,
    generate_ai_summary: bool = True,
) -> dict[str, Any]:
    """
    Aggregate real data and transform it into the format expected by
    _render_daily_report_html().

    This is the single entry point for building report email payloads,
    used by both the test-email endpoint and the future scheduler.

    Args:
        reference_date: 补发时指定的数据锚定日期。为 None 时自动计算（当天最近完整日期）。
    """
    # 锚定日期 = 最近一个数据完整的日期
    # 补发时使用指定的历史日期，正常调度时自动计算
    today = reference_date if reference_date is not None else _get_report_anchor_date(country)
    days = 7
    period_start = today - timedelta(days=days - 1)

    # 1. 用本地查询替代 dashboard overview 聚合接口，只保留报表所需字段
    sales_snapshot, sales_trend, p7d_sales_qty = _query_sales_snapshot(
        db, project_ids, country, period_start, today
    )
    project_names = _query_project_names(db, project_ids)
    inventory_summary = _query_inventory_summary(db, project_ids, country)
    shipment_snapshot = _query_shipment_snapshot(db, project_ids, country)

    # 2. Transform sales
    sales = {
        "yesterday_qty": sales_snapshot.get("today_order_qty", 0),
        "yesterday_amount": float(sales_snapshot.get("today_sales_amount", 0)),
        "prev_qty": sales_snapshot.get("prev_order_qty", 0),
        "change_pct": sales_snapshot.get("order_qty_change_pct", 0.0),
    }

    # 3. Week sales (sum the trend)
    week_sales = {
        "week_qty": p7d_sales_qty,
        "week_amount": sum(t.get("sales_amount", 0.0) for t in sales_trend),
    }

    # 4b. Previous week sales for comparison
    prev_period_start = period_start - timedelta(days=days)
    prev_period_end = period_start - timedelta(days=1)
    prev_week_sales = _query_period_sales(db, project_ids, country, prev_period_start, prev_period_end)

    # 5. Trend days (last 7 items, format date as MM-DD)
    trend_days = []
    for t in sales_trend[-7:]:
        d = t.get("date", "")
        short_date = d[5:] if len(d) >= 10 else d  # "2026-05-16" -> "05-16"
        trend_days.append({"date": short_date, "qty": t.get("order_qty", 0)})

    # 5b. SKU sales detail for single day (anchor date)
    sku_sales_detail = _query_sku_sales_detail(db, project_ids, country, today, today)

    # 6. Top SKUs (query DB directly)
    top_skus = _query_top_skus(db, project_ids, country, period_start, today, limit=5)

    # 6. Inventory (+ OOS and low stock details)
    oos_skus, low_stock_skus = _query_inventory_alerts(db, project_ids, country)
    inventory = {
        "sku_count": inventory_summary.get("sku_count", 0),
        "oos_skus": oos_skus,
        "low_stock_skus": low_stock_skus,
        "total_available": inventory_summary.get("available_qty", 0),
        "in_transit": shipment_snapshot.get("in_transit_qty", 0),
    }

    # 7. Build alert rows for email
    alert_rows = []
    for item in oos_skus[:3]:
        alert_rows.append({
            "badge_color": "#DC2626",
            "badge": "缺货",
            "sku": item.get("sku", ""),
            "qty": 0,
        })
    for item in low_stock_skus[:3]:
        alert_rows.append({
            "badge_color": "#F59E0B",
            "badge": "告急",
            "sku": item.get("sku", ""),
            "qty": item.get("available_qty", 0),
        })

    # 8. Ads
    # 根据报告频率选择广告数据源：
    # - 日报：使用单日广告数据（精确到目标日期的实际数据）
    # - 周报/月报：使用本地近 7 天聚合数据
    if frequency == "daily":
        ads = _query_ads_single_day(db, project_ids, country, today)
        # 广告占比分母 = 单日全站总销售额（与单日广告花费口径一致）
        ad_ratio_denominator = float(sales_snapshot.get("today_sales_amount", 0) or 0)
    else:
        ads = _query_ads_period(db, project_ids, country, period_start, today)
        # 广告占比分母 = 近 7 天全站总销售额（与 _query_ads_period 周期一致）
        ad_ratio_denominator = float(week_sales.get("week_amount", 0) or 0)

    # 广告占比 = 广告花费 / 总销售额（全站销售额，不仅广告销售额）
    ad_spend = float(ads.get("spend", 0) or 0)
    ads["ad_ratio_all"] = (
        round(ad_spend / ad_ratio_denominator * 100, 2) if ad_ratio_denominator > 0 else 0.0
    )

    # 9. Returns（从 AnalysisReturnRow 直接查询近7天数据）
    # 注意：退货报表是累积的，同一退货事件可能出现在多个 source_file 中
    # 必须按 (order_id, sku, return_date, license_plate_number) 去重
    try:
        # 先查询所有匹配的退货记录
        ret_base_query = (
            db.query(AnalysisReturnRow)
            .join(AnalysisSourceFile, AnalysisSourceFile.id == AnalysisReturnRow.source_file_id)
            .filter(
                AnalysisSourceFile.country == country,
                AnalysisSourceFile.report_type == "return_report",
                AnalysisSourceFile.is_current == True,
                AnalysisReturnRow.return_date >= period_start,
                AnalysisReturnRow.return_date <= today,
            )
        )
        if project_ids:
            ret_base_query = ret_base_query.filter(AnalysisSourceFile.project_id.in_(project_ids))

        all_return_records = ret_base_query.all()

        # Dec 2026-05-26: Database-level unique constraint (uq_return_event)
        # guarantees dedup at write time. No Python-level dedup needed.
        deduped_records = [(r.source_file_id, r) for r in all_return_records]
        ret_qty = sum(r.quantity for _, r in deduped_records)

        # Top return reasons 也用去重后的数据
        reason_counts: dict[str, tuple[int, int]] = {}  # reason -> (qty, count)
        for _, r in deduped_records:
            if r.reason:
                current = reason_counts.get(r.reason, (0, 0))
                reason_counts[r.reason] = (current[0] + r.quantity, current[1] + 1)

        top_returns = [
            {"reason": reason, "qty": qty}
            for reason, (qty, _) in sorted(reason_counts.items(), key=lambda x: x[1][0], reverse=True)[:3]
        ]
    except Exception as e:
        logger.warning("Failed to query return data: %s", e)
        ret_qty = 0
        top_returns = []
    
    # 计算退货率（基于7天销售）
    ret_rate = round(ret_qty / p7d_sales_qty * 100, 2) if p7d_sales_qty > 0 else 0.0
    
    returns = {
        "qty": ret_qty,
        "rate": ret_rate,
        "top_returns": top_returns,
    }

    # 10. AI summary - built below after report_data is assembled

    # 11. Meta
    project_name = ", ".join(project_names) if project_names else "全部项目"
    date_range = f"{period_start.isoformat()} ~ {today.isoformat()}"

    # 12. Build complete report_data for AI summary
    report_data = {
        "sales": sales,
        "week_sales": week_sales,
        "prev_week_sales": prev_week_sales,
        "trend_days": trend_days,
        "top_skus": top_skus,
        "inventory": inventory,
        "ads": ads,
        "returns": returns,
        "country": country,
        "report_date": today.isoformat(),
        "date_range": date_range,
    }

    # 12b. Fetch project context & SKU factory info for AI enrichment
    project_context, sku_context = fetch_multi_project_context(db, project_ids)
    top_sku_names = [s.get("sku") for s in top_skus if s.get("sku")]
    alert_sku_names = [s.get("sku") for s in oos_skus[:3]] + [s.get("sku") for s in low_stock_skus[:3]]
    relevant_skus = list(dict.fromkeys(top_sku_names + alert_sku_names))
    sku_factory_info_text = fetch_and_format_sku_factory_info(db, relevant_skus, country, project_ids)
    report_data["project_context"] = project_context
    report_data["sku_context"] = sku_context
    report_data["sku_factory_info_text"] = sku_factory_info_text

    ai_summary = ""
    if generate_ai_summary:
        # 通知调度器：数据获取完成，开始生成 AI 摘要
        if stage_callback:
            from app.models.scheduled_report import DeliveryStage
            stage_callback(DeliveryStage.GENERATING_SUMMARY.value)

        ai_summary = _generate_summary(frequency, report_data, ai_model, timeout=ai_timeout)

    # 13. Build weekly report data format for email renderer
    curr_qty = week_sales.get("week_qty", 0)
    curr_amount = week_sales.get("week_amount", 0)
    prev_qty = prev_week_sales.get("week_qty", 0)
    prev_amount = prev_week_sales.get("week_amount", 0)
    
    qty_change = ((curr_qty - prev_qty) / prev_qty * 100) if prev_qty > 0 else 0
    amount_change = ((curr_amount - prev_amount) / prev_amount * 100) if prev_amount > 0 else 0
    orders_change = qty_change  # 单量和订单数同义
    avg_price = (curr_amount / curr_qty) if curr_qty > 0 else 0
    prev_avg_price = (prev_amount / prev_qty) if prev_qty > 0 else 0
    avg_price_change = ((avg_price - prev_avg_price) / prev_avg_price * 100) if prev_avg_price > 0 else 0
    
    # 上周日期范围
    prev_week_range = f"{prev_period_start.isoformat()} ~ {prev_period_end.isoformat()}"
    
    weekly_report_data = {
        "project_name": project_name,
        "country": country,
        "week_number": today.isocalendar()[1] if frequency == "weekly" else "",
        "date_range": date_range,
        "prev_week_range": prev_week_range,
        "current_week": {
            "qty": curr_qty,
            "amount": curr_amount,
            "avg_price": avg_price,
        },
        "prev_week": {
            "qty": prev_qty,
            "amount": prev_amount,
            "avg_price": prev_avg_price,
        },
        "changes": {
            "qty_change": qty_change,
            "amount_change": amount_change,
            "orders_change": orders_change,
            "avg_price_change": avg_price_change,
        },
        "top_skus_comparison": _build_sku_comparison(top_skus, db, project_ids, country, prev_period_start, prev_period_end),
        "alerts": alert_rows,
        "ads_comparison": _build_ads_comparison(ads),
        "inventory_alerts": inventory.get("oos_skus", []) + inventory.get("low_stock_skus", []),
        "ai_summary": ai_summary,
        "dash_url": "https://dash.believeboy.com/dashboard",
    }

    # 计算近7天对比数据
    prev_7d_qty = prev_week_sales.get("week_qty", 0)
    prev_7d_amt = prev_week_sales.get("week_amount", 0.0)
    curr_7d_qty = week_sales.get("week_qty", 0)
    curr_7d_amt = week_sales.get("week_amount", 0.0)
    
    period7d_change_pct = ((curr_7d_qty - prev_7d_qty) / prev_7d_qty * 100) if prev_7d_qty > 0 else 0
    period7d_amount_change_pct = ((curr_7d_amt - prev_7d_amt) / prev_7d_amt * 100) if prev_7d_amt > 0 else 0
    
    return {
        "sales": sales,                  # 今日数据（锚定日）
        "week_sales": week_sales,        # 近7天累计
        "prev_week_sales": prev_week_sales,  # 上周期（用于计算变化率）
        "period7d_change_pct": period7d_change_pct,
        "period7d_amount_change_pct": period7d_amount_change_pct,
        "period_start": period_start.isoformat(),
        "period_end": today.isoformat(),
        "prev_period_start": prev_period_start.isoformat(),
        "prev_period_end": prev_period_end.isoformat(),
        "trend_days": trend_days,
        "top_skus": top_skus,
        "sku_sales_detail": sku_sales_detail,
        "inventory": inventory,
        "alert_rows": alert_rows,
        "ads": ads,
        "returns": returns,
        "ai_summary": ai_summary,
        "project_name": project_name,
        "country": country,
        "report_date": today.isoformat(),
        "date_range": date_range,
    }


def _query_top_skus(
    db: Session,
    project_ids: list[int] | None,
    country: str,
    start_date: date,
    end_date: date,
    limit: int = 5,
) -> list[dict[str, Any]]:
    """Query top-selling SKUs in the period."""
    try:
        query = (
            db.query(
                AnalysisSalesOrderRow.sku,
                func.sum(AnalysisSalesOrderRow.quantity).label("total_qty"),
                func.sum(
                    func.coalesce(AnalysisSalesOrderRow.item_price, 0)
                    + func.coalesce(AnalysisSalesOrderRow.shipping_price, 0)
                ).label("total_amount"),
            )
            .join(AnalysisSourceFile, AnalysisSourceFile.id == AnalysisSalesOrderRow.source_file_id)
            .filter(
                AnalysisSourceFile.country == country,
                AnalysisSourceFile.report_type == "sales_report",
                AnalysisSourceFile.is_current == True,  # noqa: E712
                AnalysisSalesOrderRow.purchase_date_pt >= start_date,
                AnalysisSalesOrderRow.purchase_date_pt <= end_date,
            )
        )
        if project_ids:
            query = query.filter(AnalysisSourceFile.project_id.in_(project_ids))

        query = (
            query
            .group_by(AnalysisSalesOrderRow.sku)
            .order_by(func.sum(AnalysisSalesOrderRow.quantity).desc())
            .limit(limit)
        )

        return [
            {
                "sku": row.sku or "Unknown",
                "qty": int(row.total_qty or 0),
                "amount": float(row.total_amount or 0),
            }
            for row in query.all()
        ]
    except Exception as e:
        logger.warning("Failed to query top SKUs: %s", e)
        return []


def _query_inventory_alerts(
    db: Session,
    project_ids: list[int] | None,
    country: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Query out-of-stock and low-stock SKUs. Returns (oos_list, low_stock_list)."""
    try:
        base_query = (
            db.query(
                InventorySnapshotRow.sku,
                InventorySnapshotRow.available_qty,
                InventorySnapshotRow.stock_status,
            )
            .join(AnalysisSourceFile, AnalysisSourceFile.id == InventorySnapshotRow.source_file_id)
            .filter(
                AnalysisSourceFile.country == country,
                AnalysisSourceFile.report_type == "inventory_report",
                AnalysisSourceFile.is_current == True,  # noqa: E712
            )
        )
        if project_ids:
            base_query = base_query.filter(AnalysisSourceFile.project_id.in_(project_ids))

        oos = []
        low = []
        for row in base_query.filter(
            InventorySnapshotRow.available_qty <= 10
        ).order_by(
            InventorySnapshotRow.available_qty.asc()
        ).limit(20).all():
            item = {"sku": row.sku or "Unknown", "available_qty": int(row.available_qty or 0)}
            if row.available_qty <= 0 or row.stock_status == "out_of_stock":
                oos.append(item)
            else:
                low.append(item)
        return oos, low
    except Exception as e:
        logger.warning("Failed to query inventory alerts: %s", e)
        return [], []


def _query_top_return_reasons(
    db: Session,
    project_ids: list[int] | None,
    country: str,
    start_date: date,
    end_date: date,
) -> list[dict[str, Any]]:
    """Query top return reasons in the period using AnalysisReturnRow."""
    try:
        query = (
            db.query(
                AnalysisReturnRow.reason,
                func.count().label("cnt"),
                func.sum(AnalysisReturnRow.quantity).label("total_qty"),
            )
            .join(AnalysisSourceFile, AnalysisSourceFile.id == AnalysisReturnRow.source_file_id)
            .filter(
                AnalysisSourceFile.country == country,
                AnalysisSourceFile.report_type == "return_report",
                AnalysisSourceFile.is_current == True,  # noqa: E712
                AnalysisReturnRow.return_date >= start_date,
                AnalysisReturnRow.return_date <= end_date,
                AnalysisReturnRow.reason.isnot(None),
                AnalysisReturnRow.reason != "",
            )
        )
        if project_ids:
            query = query.filter(AnalysisSourceFile.project_id.in_(project_ids))

        query = (
            query
            .group_by(AnalysisReturnRow.reason)
            .order_by(func.count().desc())
            .limit(3)
        )

        return [
            {"reason": row.reason or "未知", "qty": int(row.total_qty or 0)}
            for row in query.all()
        ]
    except Exception as e:
        logger.warning("Failed to query return reasons: %s", e)
        return []


# AI summary timeout is read per-call from env via get_ai_timeout_sec().
# Set AI_SUMMARY_TIMEOUT_SEC=0 to disable AI and force the fallback summary.
# Default 30s. See app/services/scheduled_report/ai_timeout.py.


def _generate_summary(
    frequency: str,
    overview: dict[str, Any],
    model: str | None = None,
    timeout: float | None = None,
) -> str:
    """Generate AI summary with a configurable timeout.

    Uses a thread-based timeout so it works both on the main thread
    and inside ThreadPoolExecutor workers (where SIGALRM is unavailable).

    If the AI call exceeds *timeout* seconds, a fallback text summary is
    returned immediately and the rest of the pipeline proceeds without
    blocking on screenshot / email delivery.

    Args:
        frequency: "daily" / "weekly" / "monthly"
        overview: Report data dict passed to the AI prompt
        model: Optional model override
        timeout: Max seconds to wait for AI. Defaults to get_ai_timeout_sec(frequency).
    """
    secs = timeout if timeout is not None else get_ai_timeout_sec(frequency)

    if secs <= 0:
        return _generate_fallback_summary(frequency, overview)

    from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeout

    def _call_ai():
        from app.services.scheduled_report.ai_enhancer_daily import generate_ai_summary
        return generate_ai_summary(frequency, overview, model=model)

    try:
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(_call_ai)
            return future.result(timeout=secs)
    except FuturesTimeout:
        logger.warning(
            "AI summary timed out (%.0fs) for frequency=%s — using fallback",
            secs, frequency,
        )
        return _generate_fallback_summary(frequency, overview)
    except Exception as e:
        logger.warning("AI summary failed, using fallback: %s", e)
        return _generate_fallback_summary(frequency, overview)


def _generate_fallback_summary(frequency: str, overview: dict[str, Any]) -> str:
    """当 AI 服务不可用或超时时，生成基础摘要。"""
    from app.services.scheduled_report.email_sender import _fmt_currency

    sales = overview.get("sales", {})
    week_sales = overview.get("week_sales", {})
    inventory = overview.get("inventory", {})
    country = overview.get("country", "US")

    today_qty = sales.get("yesterday_qty", 0)
    today_amt = sales.get("yesterday_amount", 0.0)
    vs_prev = sales.get("change_pct", 0.0)

    p7d_qty = week_sales.get("week_qty", 0)
    p7d_amt = week_sales.get("week_amount", 0.0)

    total_available = inventory.get("total_available", 0)
    in_transit = inventory.get("in_transit", 0)

    dir_label = "增长" if vs_prev >= 0 else "下降"
    amt_str = f"/{_fmt_currency(today_amt, country)}" if today_amt > 0 else ""
    p7d_amt_str = f"/{_fmt_currency(p7d_amt, country)}" if p7d_amt > 0 else ""
    parts = [f"昨日销量{today_qty}单{amt_str}，较前一日{dir_label}{abs(vs_prev):.1f}%（近7天累计{p7d_qty}单{p7d_amt_str}）"]

    inv_parts = [f"库存{total_available}件"]
    if in_transit > 0:
        inv_parts.append(f"在途{in_transit}件")
    parts.append("，".join(inv_parts))

    return "；".join(parts)


def _query_period_sales(
    db: Session,
    project_ids: list[int] | None,
    country: str,
    start_date: date,
    end_date: date,
) -> dict[str, Any]:
    """查询指定日期范围的销售汇总。"""
    try:
        query = (
            db.query(
                func.coalesce(func.sum(AnalysisSalesOrderRow.quantity), 0).label("qty"),
                func.coalesce(func.sum(
                    func.coalesce(AnalysisSalesOrderRow.item_price, 0) +
                    func.coalesce(AnalysisSalesOrderRow.shipping_price, 0)
                ), 0).label("amount"),
            )
            .join(AnalysisSourceFile, AnalysisSourceFile.id == AnalysisSalesOrderRow.source_file_id)
            .filter(
                AnalysisSourceFile.country == country,
                AnalysisSourceFile.report_type == "sales_report",
                AnalysisSourceFile.is_current == True,  # noqa: E712
                AnalysisSalesOrderRow.purchase_date_pt >= start_date,
                AnalysisSalesOrderRow.purchase_date_pt <= end_date,
            )
        )
        if project_ids:
            query = query.filter(AnalysisSourceFile.project_id.in_(project_ids))

        row = query.first()
        return {
            "week_qty": int(row.qty) if row and row.qty else 0,
            "week_amount": float(row.amount) if row and row.amount else 0.0,
        }
    except Exception as e:
        logger.warning("Failed to query period sales: %s", e)
        return {"week_qty": 0, "week_amount": 0.0}


def _build_sku_comparison(
    top_skus: list[dict],
    db: Session,
    project_ids: list[int] | None,
    country: str,
    prev_start: date,
    prev_end: date,
) -> list[dict]:
    """构建 SKU 对比数据：本周销量 vs 上周销量"""
    # 查询上周同期 top skus
    prev_skus = _query_top_skus(db, project_ids, country, prev_start, prev_end, limit=10)
    prev_sku_map = {s.get("sku"): s.get("qty", 0) for s in prev_skus}
    
    comparison = []
    for sku in top_skus[:8]:
        sku_name = sku.get("sku", "")
        curr_qty = sku.get("qty", 0)
        prev_qty = prev_sku_map.get(sku_name, 0)
        change = ((curr_qty - prev_qty) / prev_qty * 100) if prev_qty > 0 else (100 if curr_qty > 0 else 0)
        
        comparison.append({
            "sku": sku_name,
            "current": curr_qty,
            "prev": prev_qty,
            "change": change,
            "new": prev_qty == 0 and curr_qty > 0,
        })
    
    return comparison


def _build_ads_comparison(ads: dict) -> dict:
    """构建广告对比数据"""
    spend = ads.get("spend", 0)
    sales = ads.get("sales", 0)
    roas = ads.get("roas", 0)
    return {
        "spend": spend,
        "sales": sales,
        "roas": roas,
        "acos": ads.get("acos", 0),
        "ctr": ads.get("ctr", 0),
        "orders": ads.get("orders", 0),
    }


def _query_ads_single_day(
    db: Session,
    project_ids: list[int] | None,
    country: str,
    target_date: date,
) -> dict[str, Any]:
    """查询指定单日的广告数据（用于日报）。

    广告报告通常以 period_end_date 为基准，所以 target_date 会被作为 period_end_date 过滤。
    """
    try:
        query = (
            db.query(
                func.coalesce(func.sum(AdUploadPromotedProductRow.spend), 0).label("spend"),
                func.coalesce(func.sum(AdUploadPromotedProductRow.sales_7d), 0).label("sales"),
                func.coalesce(func.sum(AdUploadPromotedProductRow.clicks), 0).label("clicks"),
                func.coalesce(func.sum(AdUploadPromotedProductRow.impressions), 0).label("impressions"),
                func.coalesce(func.sum(AdUploadPromotedProductRow.orders_7d), 0).label("orders"),
            )
            .join(
                AdUploadFile,
                AdUploadFile.id == AdUploadPromotedProductRow.source_file_id,
            )
            .filter(
                AdUploadFile.country == country,
                AdUploadFile.report_type == "ad_promoted_product_report",
                AdUploadFile.is_current == True,  # noqa: E712
                AdUploadFile.period_end_date == target_date,
                AdUploadPromotedProductRow.scope_status == "included_product",
            )
        )
        if project_ids:
            query = query.filter(AdUploadFile.project_id.in_(project_ids))

        row = query.first()

        spend = float(row.spend or 0) if row else 0
        sales = float(row.sales or 0) if row else 0
        clicks = int(row.clicks or 0) if row else 0
        impressions = int(row.impressions or 0) if row else 0
        orders = int(row.orders or 0) if row else 0

        roas = round(sales / spend, 2) if spend > 0 else 0.0
        acos = round(spend / sales * 100, 2) if sales > 0 else 0.0
        ctr = round(clicks / impressions * 100, 2) if impressions > 0 else 0.0

        return {
            "spend": round(spend, 2),
            "sales": round(sales, 2),
            "roas": roas,
            "acos": acos,
            "ctr": ctr,
            "orders": orders,
        }
    except Exception as e:
        logger.warning("Failed to query single-day ads for %s: %s", target_date, e)
        return {
            "spend": 0.0,
            "sales": 0.0,
            "roas": 0.0,
            "acos": 0.0,
            "ctr": 0.0,
            "orders": 0,
        }


def _query_sku_sales_detail(
    db: Session,
    project_ids: list[int] | None,
    country: str,
    start_date: date,
    end_date: date,
) -> list[dict[str, Any]]:
    """查询指定日期范围的 SKU 销售明细（含品名）。

    按销量降序排列，过滤掉数量和销售额都为 0 的 SKU。
    """
    try:
        # 1) 聚合每个 SKU 的销售数据
        query = (
            db.query(
                AnalysisSalesOrderRow.sku,
                func.sum(AnalysisSalesOrderRow.quantity).label("total_qty"),
                func.sum(
                    func.coalesce(AnalysisSalesOrderRow.item_price, 0)
                    + func.coalesce(AnalysisSalesOrderRow.shipping_price, 0)
                ).label("total_amount"),
            )
            .join(AnalysisSourceFile, AnalysisSourceFile.id == AnalysisSalesOrderRow.source_file_id)
            .filter(
                AnalysisSourceFile.country == country,
                AnalysisSourceFile.report_type == "sales_report",
                AnalysisSourceFile.is_current == True,  # noqa: E712
                AnalysisSalesOrderRow.purchase_date_pt >= start_date,
                AnalysisSalesOrderRow.purchase_date_pt <= end_date,
            )
        )
        if project_ids:
            query = query.filter(AnalysisSourceFile.project_id.in_(project_ids))

        results = (
            query
            .group_by(AnalysisSalesOrderRow.sku)
            .order_by(func.sum(AnalysisSalesOrderRow.quantity).desc())
            .all()
        )

        # 2) 批量获取品名映射 (sku -> product_name)
        sku_names: dict[str, str] = {}
        sku_list = [r.sku for r in results if r.sku]
        if sku_list:
            name_query = (
                db.query(SkuRecord.sku, SkuRecord.product_name)
                .filter(
                    SkuRecord.sku.in_(sku_list),
                    SkuRecord.country == country,
                    SkuRecord.is_active == True,  # noqa: E712
                )
            )
            if project_ids:
                name_query = name_query.filter(SkuRecord.project_id.in_(project_ids))

            for row in name_query.all():
                if row.sku and row.product_name:
                    sku_names[row.sku] = row.product_name

        # 3) 组装结果，过滤掉数量和销售额都为 0 的行
        detail: list[dict[str, Any]] = []
        for r in results:
            qty = int(r.total_qty or 0)
            amount = float(r.total_amount or 0)
            if qty == 0 and amount == 0:
                continue
            detail.append({
                "sku": r.sku or "Unknown",
                "product_name": sku_names.get(r.sku, "—"),
                "qty": qty,
                "amount": amount,
            })

        return detail
    except Exception as e:
        logger.warning("Failed to query SKU sales detail: %s", e)
        return []
