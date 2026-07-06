"""Build monthly report data structure with natural month calculation.

Uses natural months (1st to last day) and provides:
- Month-over-month (MoM) comparison
- Year-over-year (YoY) comparison
- Weekly trend breakdown within the month
"""

from __future__ import annotations

import logging
from datetime import date, timedelta
from typing import Any
from calendar import monthrange

from sqlalchemy import func, case
from sqlalchemy.orm import Session

from app.models import (
    AdUploadFile,
    AdUploadPromotedProductRow,
    AnalysisReturnRow,
    AnalysisSalesOrderRow,
    AnalysisSourceFile,
    InventorySnapshotRow,
)
from app.models.project import Project
from app.models.sku_info import SkuRecord
from app.services.scheduled_report.context_helpers import (
    fetch_and_format_sku_factory_info,
    fetch_multi_project_context,
)
from app.utils.country import get_today_for_country

from .ai_enhancer_monthly import (
    detect_monthly_anomalies,
    generate_monthly_action_items,
    generate_monthly_alert_insights,
    generate_monthly_ai_summary,
    generate_monthly_attribution_analysis,
)

logger = logging.getLogger(__name__)


# ── Time calculation helpers ─────────────────────────────────────────────────


def _get_report_month(anchor_date: date) -> tuple[date, date]:
    """计算上一个完整自然月的起止日期。

    示例：
      anchor_date = 2026-07-05 → 报告月 = (2026-06-01, 2026-06-30)
      anchor_date = 2026-06-01 → 报告月 = (2026-05-01, 2026-05-31)
    """
    first_of_current_month = anchor_date.replace(day=1)
    last_of_prev_month = first_of_current_month - timedelta(days=1)
    first_of_prev_month = last_of_prev_month.replace(day=1)
    return first_of_prev_month, last_of_prev_month


def _get_prev_month(month_start: date) -> tuple[date, date]:
    """计算报告月前一个月的起止日期。"""
    first_of_report_month = month_start.replace(day=1)
    last_of_prev = first_of_report_month - timedelta(days=1)
    first_of_prev = last_of_prev.replace(day=1)
    return first_of_prev, last_of_prev


def _get_yoy_month(month_start: date, month_end: date) -> tuple[date, date]:
    """计算去年同月的起止日期。处理 2 月 29→28 边界。"""
    yoy_start = month_start.replace(year=month_start.year - 1)
    max_day = monthrange(yoy_start.year, yoy_start.month)[1]
    yoy_end_day = min(month_end.day, max_day)
    yoy_end = yoy_start.replace(day=yoy_end_day)
    return yoy_start, yoy_end


def _get_report_anchor_date(country: str) -> date:
    """计算报告的数据锚定日期 — 最近一个数据完整的日期。"""
    country_today = get_today_for_country(country)
    server_yesterday = date.today() - timedelta(days=1)
    return min(country_today, server_yesterday)


def _calc_change_pct(current: float, prev: float) -> float:
    """计算变化百分比。"""
    if prev == 0:
        return 0.0
    return ((current - prev) / prev) * 100


def _format_date_range(start: date, end: date) -> str:
    """格式化日期范围为中文描述。"""
    return f"{start.month}月{start.day}日 - {end.month}月{end.day}日"


def _resolve_project_name(db: Session, project_ids: list[int] | None) -> str:
    """根据 project_ids 从数据库查询实际项目名称。"""
    if not project_ids:
        return "全部项目"
    names = (
        db.query(Project.project_name)
        .filter(Project.id.in_(project_ids))
        .order_by(Project.id)
        .all()
    )
    if not names:
        return "全部项目"
    return ", ".join(n[0] for n in names)


# ── Data aggregation functions ───────────────────────────────────────────────


def _aggregate_monthly_sales(
    db: Session,
    project_ids: list[int] | None,
    country: str,
    start_date: date,
    end_date: date,
) -> dict[str, Any]:
    """聚合指定月份的销售数据。"""
    try:
        query = (
            db.query(
                func.coalesce(func.sum(AnalysisSalesOrderRow.quantity), 0).label("qty"),
                func.coalesce(func.sum(
                    func.coalesce(AnalysisSalesOrderRow.item_price, 0) +
                    func.coalesce(AnalysisSalesOrderRow.shipping_price, 0)
                ), 0).label("amount"),
                func.count(func.distinct(AnalysisSalesOrderRow.purchase_date_pt)).label("active_days"),
            )
            .join(AnalysisSourceFile, AnalysisSourceFile.id == AnalysisSalesOrderRow.source_file_id)
            .filter(
                AnalysisSourceFile.country == country,
                AnalysisSourceFile.report_type == "sales_report",
                AnalysisSourceFile.is_current == True,
                AnalysisSalesOrderRow.purchase_date_pt >= start_date,
                AnalysisSalesOrderRow.purchase_date_pt <= end_date,
            )
        )
        if project_ids:
            query = query.filter(AnalysisSourceFile.project_id.in_(project_ids))

        row = query.first()

        qty = int(row.qty) if row and row.qty else 0
        amount = float(row.amount) if row and row.amount else 0.0
        avg_price = amount / qty if qty > 0 else 0.0

        return {
            "qty": qty,
            "amount": amount,
            "avg_price": avg_price,
            "start_date": start_date.isoformat(),
            "end_date": end_date.isoformat(),
        }
    except Exception as e:
        logger.warning("Failed to aggregate monthly sales: %s", e)
        return {
            "qty": 0,
            "amount": 0.0,
            "avg_price": 0.0,
            "start_date": start_date.isoformat(),
            "end_date": end_date.isoformat(),
        }


def _query_sku_sales_detail(
    db: Session,
    project_ids: list[int] | None,
    country: str,
    start_date: date,
    end_date: date,
) -> list[dict[str, Any]]:
    """查询指定月份的 SKU 销售明细（含品名）。"""
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
                AnalysisSourceFile.is_current == True,
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

        # 批量获取品名映射
        sku_names: dict[str, str] = {}
        sku_list = [r.sku for r in results if r.sku]
        if sku_list:
            name_query = (
                db.query(SkuRecord.sku, SkuRecord.product_name)
                .filter(
                    SkuRecord.sku.in_(sku_list),
                    SkuRecord.country == country,
                    SkuRecord.is_active == True,
                )
            )
            if project_ids:
                name_query = name_query.filter(SkuRecord.project_id.in_(project_ids))
            for row in name_query.all():
                if row.sku and row.product_name:
                    sku_names[row.sku] = row.product_name

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
        logger.warning("Failed to query monthly SKU sales detail: %s", e)
        return []


def _get_weekly_trend_in_month(
    db: Session,
    project_ids: list[int] | None,
    country: str,
    month_start: date,
    month_end: date,
) -> list[dict[str, Any]]:
    """将月拆为自然周（周一~周日），返回每周的销量/金额。"""
    result = []
    current = month_start
    week_num = 1

    # 如果月1日不是周一，第一段从月1日到第一个周日
    if current.weekday() != 0:
        days_to_sunday = (6 - current.weekday()) % 7
        if days_to_sunday == 0:
            days_to_sunday = 7
        segment_end = min(current + timedelta(days=days_to_sunday - 1), month_end)
        sales = _aggregate_monthly_sales(db, project_ids, country, current, segment_end)
        result.append({
            "week_num": week_num,
            "start": current.isoformat(),
            "end": segment_end.isoformat(),
            "label": f"第{week_num}周",
            "qty": sales["qty"],
            "amount": sales["amount"],
        })
        current = segment_end + timedelta(days=1)
        week_num = 2

    # 完整自然周
    while current <= month_end:
        week_start = current
        week_end = min(current + timedelta(days=6), month_end)
        sales = _aggregate_monthly_sales(db, project_ids, country, week_start, week_end)
        result.append({
            "week_num": week_num,
            "start": week_start.isoformat(),
            "end": week_end.isoformat(),
            "label": f"第{week_num}周",
            "qty": sales["qty"],
            "amount": sales["amount"],
        })
        current = week_end + timedelta(days=1)
        week_num += 1

    return result


def _get_top_skus_monthly_comparison(
    db: Session,
    project_ids: list[int] | None,
    country: str,
    curr_start: date, curr_end: date,
    prev_start: date, prev_end: date,
    yoy_start: date, yoy_end: date,
    limit: int = 10,
) -> list[dict[str, Any]]:
    """获取本月 TOP SKU，附带上月和去年同月数据做三级对比。"""
    try:
        # 查询三个时段合并的 SKU 数据（使用 CASE WHEN 避免三次查询）
        # 先查本月和上月的数据
        query = (
            db.query(
                AnalysisSalesOrderRow.sku,
                func.sum(
                    case(
                        (AnalysisSalesOrderRow.purchase_date_pt.between(curr_start, curr_end), AnalysisSalesOrderRow.quantity),
                        else_=0,
                    )
                ).label("curr_qty"),
                func.sum(
                    case(
                        (AnalysisSalesOrderRow.purchase_date_pt.between(prev_start, prev_end), AnalysisSalesOrderRow.quantity),
                        else_=0,
                    )
                ).label("prev_qty"),
                func.sum(
                    case(
                        (AnalysisSalesOrderRow.purchase_date_pt.between(curr_start, curr_end),
                         AnalysisSalesOrderRow.item_price + AnalysisSalesOrderRow.shipping_price),
                        else_=0,
                    )
                ).label("curr_amount"),
                func.sum(
                    case(
                        (AnalysisSalesOrderRow.purchase_date_pt.between(yoy_start, yoy_end), AnalysisSalesOrderRow.quantity),
                        else_=0,
                    )
                ).label("yoy_qty"),
                func.sum(
                    case(
                        (AnalysisSalesOrderRow.purchase_date_pt.between(yoy_start, yoy_end),
                         AnalysisSalesOrderRow.item_price + AnalysisSalesOrderRow.shipping_price),
                        else_=0,
                    )
                ).label("yoy_amount"),
            )
            .join(AnalysisSourceFile, AnalysisSourceFile.id == AnalysisSalesOrderRow.source_file_id)
            .filter(
                AnalysisSourceFile.country == country,
                AnalysisSourceFile.report_type == "sales_report",
                AnalysisSourceFile.is_current == True,
                # 优化：只查涉及的时间范围
                AnalysisSalesOrderRow.purchase_date_pt.between(yoy_start, curr_end),
            )
        )
        if project_ids:
            query = query.filter(AnalysisSourceFile.project_id.in_(project_ids))

        results = (
            query.group_by(AnalysisSalesOrderRow.sku)
            .order_by(func.sum(
                case(
                    (AnalysisSalesOrderRow.purchase_date_pt.between(curr_start, curr_end), AnalysisSalesOrderRow.quantity),
                    else_=0,
                )
            ).desc())
            .limit(limit)
            .all()
        )

        # 批量获取品名
        sku_names: dict[str, str] = {}
        sku_list = [r.sku for r in results if r.sku]
        if sku_list:
            name_rows = db.query(SkuRecord.sku, SkuRecord.product_name).filter(
                SkuRecord.sku.in_(sku_list),
                SkuRecord.country == country,
                SkuRecord.is_active == True,
            ).all()
            sku_names = {r[0]: r[1] or "" for r in name_rows}

        top_skus = []
        for r in results:
            curr_qty = int(r.curr_qty or 0)
            prev_qty = int(r.prev_qty or 0)
            yoy_qty = int(r.yoy_qty or 0)
            mom_change = _calc_change_pct(curr_qty, prev_qty)
            yoy_change = _calc_change_pct(curr_qty, yoy_qty)
            is_new = prev_qty == 0 and curr_qty > 0

            top_skus.append({
                "sku": r.sku or "Unknown",
                "product_name": sku_names.get(r.sku, "—"),
                "curr_qty": curr_qty,
                "prev_qty": prev_qty,
                "yoy_qty": yoy_qty,
                "curr_amount": float(r.curr_amount or 0),
                "yoy_amount": float(r.yoy_amount or 0),
                "mom_change": round(mom_change, 1),
                "yoy_change": round(yoy_change, 1),
                "new": is_new,
            })

        return top_skus

    except Exception as e:
        logger.warning("Failed to get monthly top SKUs: %s", e)
        return []


def _analyze_sku_monthly_attribution(
    db: Session,
    project_ids: list[int] | None,
    country: str,
    curr_start: date, curr_end: date,
    prev_start: date, prev_end: date,
    yoy_start: date, yoy_end: date,
) -> list[dict[str, Any]]:
    """分析哪些 SKU 驱动了月度销售变化。"""
    try:
        all_skus_query = (
            db.query(
                AnalysisSalesOrderRow.sku,
                func.sum(
                    case(
                        (AnalysisSalesOrderRow.purchase_date_pt.between(curr_start, curr_end), AnalysisSalesOrderRow.quantity),
                        else_=0,
                    )
                ).label("curr_qty"),
                func.sum(
                    case(
                        (AnalysisSalesOrderRow.purchase_date_pt.between(prev_start, prev_end), AnalysisSalesOrderRow.quantity),
                        else_=0,
                    )
                ).label("prev_qty"),
                func.sum(
                    case(
                        (AnalysisSalesOrderRow.purchase_date_pt.between(yoy_start, yoy_end), AnalysisSalesOrderRow.quantity),
                        else_=0,
                    )
                ).label("yoy_qty"),
            )
            .join(AnalysisSourceFile, AnalysisSourceFile.id == AnalysisSalesOrderRow.source_file_id)
            .filter(
                AnalysisSourceFile.country == country,
                AnalysisSourceFile.report_type == "sales_report",
                AnalysisSourceFile.is_current == True,
                AnalysisSalesOrderRow.purchase_date_pt.between(yoy_start, curr_end),
            )
        )
        if project_ids:
            all_skus_query = all_skus_query.filter(AnalysisSourceFile.project_id.in_(project_ids))

        results = all_skus_query.group_by(AnalysisSalesOrderRow.sku).all()

        total_curr = sum(int(r.curr_qty or 0) for r in results)
        total_prev = sum(int(r.prev_qty or 0) for r in results)
        total_change = total_curr - total_prev

        attribution = []
        for r in results:
            sku = r.sku or "Unknown"
            curr_qty = int(r.curr_qty or 0)
            prev_qty = int(r.prev_qty or 0)
            yoy_qty = int(r.yoy_qty or 0)
            change = curr_qty - prev_qty
            pct = (change / total_change * 100) if total_change != 0 else 0

            if change > 0:
                change_type = "positive"
            elif change < 0:
                change_type = "negative"
            else:
                change_type = "neutral"

            change_rate = _calc_change_pct(curr_qty, prev_qty)
            yoy_change_rate = _calc_change_pct(curr_qty, yoy_qty)

            attribution.append({
                "sku": sku,
                "current_qty": curr_qty,
                "prev_qty": prev_qty,
                "yoy_qty": yoy_qty,
                "contribution": change,
                "pct": round(pct, 1),
                "type": change_type,
                "change_rate": round(change_rate, 1),
                "yoy_change_rate": round(yoy_change_rate, 1),
            })

        attribution.sort(key=lambda x: x["contribution"], reverse=True)
        return attribution[:15]

    except Exception as e:
        logger.warning("Failed to analyze monthly SKU attribution: %s", e)
        return []


def _get_ads_monthly_comparison(
    db: Session,
    project_ids: list[int] | None,
    country: str,
    curr_start: date, curr_end: date,
    prev_start: date, prev_end: date,
    yoy_start: date, yoy_end: date,
) -> dict[str, Any]:
    """获取月度广告效果对比（本月/上月/去年同月）。"""
    def _aggregate_ads(start: date, end: date) -> dict[str, float]:
        try:
            query = (
                db.query(
                    func.coalesce(func.sum(AdUploadPromotedProductRow.spend), 0).label("spend"),
                    func.coalesce(func.sum(AdUploadPromotedProductRow.sales_7d), 0).label("sales"),
                    func.coalesce(func.sum(AdUploadPromotedProductRow.clicks), 0).label("clicks"),
                    func.coalesce(func.sum(AdUploadPromotedProductRow.impressions), 0).label("impressions"),
                    func.coalesce(func.sum(AdUploadPromotedProductRow.orders_7d), 0).label("orders"),
                )
                .join(AdUploadFile, AdUploadFile.id == AdUploadPromotedProductRow.source_file_id)
                .filter(
                    AdUploadFile.country == country,
                    AdUploadFile.report_type == "ad_promoted_product_report",
                    AdUploadFile.is_current == True,
                    AdUploadFile.period_end_date >= start,
                    AdUploadFile.period_end_date <= end,
                    AdUploadPromotedProductRow.scope_status == "included_product",
                )
            )
            if project_ids:
                query = query.filter(AdUploadFile.project_id.in_(project_ids))

            row = query.first()
            spend = float(row.spend) if row and row.spend else 0.0
            sales = float(row.sales) if row and row.sales else 0.0
            clicks = int(row.clicks) if row and row.clicks else 0
            impressions = int(row.impressions) if row and row.impressions else 0

            roas = sales / spend if spend > 0 else 0.0
            acos = (spend / sales * 100) if sales > 0 else 0.0
            ctr = (clicks / impressions * 100) if impressions > 0 else 0.0

            return {"spend": spend, "sales": sales, "roas": roas, "acos": acos, "ctr": ctr}
        except Exception as e:
            logger.warning("Failed to aggregate ads for %s~%s: %s", start, end, e)
            return {"spend": 0, "sales": 0, "roas": 0, "acos": 0, "ctr": 0}

    curr = _aggregate_ads(curr_start, curr_end)
    prev = _aggregate_ads(prev_start, prev_end)
    yoy = _aggregate_ads(yoy_start, yoy_end)

    return {
        "spend": {
            "current": curr["spend"], "prev": prev["spend"], "yoy": yoy["spend"],
            "mom_change": _calc_change_pct(curr["spend"], prev["spend"]),
            "yoy_change": _calc_change_pct(curr["spend"], yoy["spend"]),
        },
        "roas": {
            "current": curr["roas"], "prev": prev["roas"], "yoy": yoy["roas"],
            "mom_change": _calc_change_pct(curr["roas"], prev["roas"]),
            "yoy_change": _calc_change_pct(curr["roas"], yoy["roas"]),
        },
        "acos": {
            "current": curr["acos"], "prev": prev["acos"], "yoy": yoy["acos"],
            "mom_change": _calc_change_pct(curr["acos"], prev["acos"]),
            "yoy_change": _calc_change_pct(curr["acos"], yoy["acos"]),
        },
        "ctr": {
            "current": curr["ctr"], "prev": prev["ctr"], "yoy": yoy["ctr"],
            "mom_change": _calc_change_pct(curr["ctr"], prev["ctr"]),
            "yoy_change": _calc_change_pct(curr["ctr"], yoy["ctr"]),
        },
    }


def _get_monthly_returns(
    db: Session,
    project_ids: list[int] | None,
    country: str,
    start_date: date,
    end_date: date,
    month_total_qty: int = 0,
) -> dict[str, Any]:
    """获取月度退货数据，退货率 = 退货数 / 月总销量。

    注意：退货报表是累积的，同一退货事件可能出现在多个 source_file 中。
    必须按 (order_id, sku, return_date, license_plate_number) 去重，
    只保留 source_file_id 最大的那条记录，避免重复计算。
    """
    try:
        query = (
            db.query(AnalysisReturnRow)
            .join(AnalysisSourceFile, AnalysisSourceFile.id == AnalysisReturnRow.source_file_id)
            .filter(
                AnalysisSourceFile.country == country,
                AnalysisSourceFile.report_type == "return_report",
                AnalysisSourceFile.is_current == True,
                AnalysisReturnRow.return_date >= start_date,
                AnalysisReturnRow.return_date <= end_date,
            )
        )
        if project_ids:
            query = query.filter(AnalysisSourceFile.project_id.in_(project_ids))

        records = query.all()

        # Python 层面去重
        seen: dict[tuple, tuple[int, AnalysisReturnRow]] = {}
        for r in records:
            key = (r.order_id, r.sku, r.return_date, r.license_plate_number or "")
            if key not in seen or r.source_file_id > seen[key][0]:
                seen[key] = (r.source_file_id, r)

        qty = sum(r.quantity for _, r in seen.values())
        rate = (qty / month_total_qty * 100) if month_total_qty > 0 else 0.0

        # 按退货原因聚合 TOP 5
        reason_qty: dict[str, int] = {}
        for _, r in seen.values():
            reason = r.reason or "未知"
            reason_qty[reason] = reason_qty.get(reason, 0) + r.quantity
        top_returns = sorted(
            [{"reason": k, "qty": v} for k, v in reason_qty.items()],
            key=lambda x: x["qty"], reverse=True,
        )[:5]

        return {
            "qty": qty,
            "rate": round(rate, 1),
            "top_returns": top_returns,
        }
    except Exception as e:
        logger.warning("Failed to get monthly returns: %s", e)
        return {"qty": 0, "rate": 0.0}


def _get_inventory_alerts(
    db: Session,
    project_ids: list[int] | None,
    country: str,
) -> list[dict[str, Any]]:
    """获取库存预警 SKU。"""
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
                AnalysisSourceFile.is_current == True,
            )
        )
        if project_ids:
            base_query = base_query.filter(AnalysisSourceFile.project_id.in_(project_ids))

        alerts = []
        for row in base_query.filter(
            InventorySnapshotRow.available_qty <= 10
        ).order_by(
            InventorySnapshotRow.available_qty.asc()
        ).limit(20).all():
            if row.available_qty <= 0 or row.stock_status == "out_of_stock":
                alerts.append({
                    "sku": row.sku or "Unknown",
                    "available_qty": int(row.available_qty or 0),
                    "level": "oos",
                })
            else:
                alerts.append({
                    "sku": row.sku or "Unknown",
                    "available_qty": int(row.available_qty or 0),
                    "level": "low",
                })
        return alerts

    except Exception as e:
        logger.warning("Failed to get inventory alerts: %s", e)
        return []


def _get_inventory_summary(db: Session, project_ids: list[int] | None, country: str) -> dict[str, Any]:
    """库存摘要（SKU 数、可用总量、低库存、缺货）。"""
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
                AnalysisSourceFile.is_current == True,
            )
        )
        if project_ids:
            query = query.filter(AnalysisSourceFile.project_id.in_(project_ids))

        rows = query.all()
        total_available = sum(int(r.available_qty or 0) for r in rows)
        low_count = sum(1 for r in rows if 0 < (r.available_qty or 0) <= 20)
        oos_count = sum(1 for r in rows if (r.available_qty or 0) <= 0 or r.stock_status == "out_of_stock")
        return {
            "sku_count": len(rows),
            "total_available": total_available,
            "low_stock_count": low_count,
            "oos_count": oos_count,
        }
    except Exception as e:
        logger.warning("Failed to get inventory summary: %s", e)
        return {"sku_count": 0, "total_available": 0, "low_stock_count": 0, "oos_count": 0}


# ── Alert helpers ────────────────────────────────────────────────────────────


def _build_alerts_from_anomalies(anomalies: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """将异常检测结果转换为告警列表。"""
    alerts = []
    for a in anomalies:
        severity = a.get("severity", "warning")
        alert_type = "critical" if severity == "critical" else "warning"
        alerts.append({
            "type": alert_type,
            "message": a.get("message", ""),
            "action": a.get("action", ""),
        })
    return alerts


def _build_inventory_alerts(inventory_alerts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """将库存预警数据转换为告警格式。"""
    alerts = []
    oos = [i for i in inventory_alerts if i.get("level") == "oos"]
    low = [i for i in inventory_alerts if i.get("level") == "low"]

    if oos:
        alerts.append({
            "type": "critical",
            "message": f"{len(oos)} 个 SKU 缺货",
            "action": "立即补货",
        })
    if low:
        alerts.append({
            "type": "warning",
            "message": f"{len(low)} 个 SKU 库存告急",
            "action": "安排补货计划",
        })
    return alerts


def _build_positive_signals(
    top_skus_comparison: list[dict[str, Any]],
    ads_comparison: dict[str, Any],
) -> list[dict[str, Any]]:
    """识别积极信号。"""
    signals = []
    # 强势 SKU
    strong_skus = [s for s in top_skus_comparison if s.get("mom_change", 0) > 50]
    if strong_skus:
        signals.append({
            "type": "positive",
            "message": f"{strong_skus[0].get('sku', 'N/A')} 环比增长 {strong_skus[0].get('mom_change', 0):.1f}%",
        })
    # ROAS 改善
    roas_mom = ads_comparison.get("roas", {}).get("mom_change", 0)
    if roas_mom > 10:
        signals.append({
            "type": "positive",
            "message": f"ROAS 环比提升 {roas_mom:.1f}%",
        })
    return signals


# ── Main entry point ─────────────────────────────────────────────────────────


def build_monthly_report_data(
    db: Session,
    project_ids: list[int] | None,
    country: str,
    project_name: str | None = None,
    reference_date: date | None = None,
    stage_callback=None,
    ai_timeout: float | None = None,
    generate_ai_summary: bool = True,
) -> dict[str, Any]:
    """构建完整的月报告数据结构。

    使用自然月计算：
    - 报告月：上一个完整自然月
    - 环比月：报告月的前一个月
    - 同比月：去年同月

    Args:
        db: 数据库会话
        project_ids: 项目 ID 列表，None 表示全部项目
        country: 国家代码
        project_name: 项目名称覆盖（不传则从数据库自动解析）
        reference_date: 补发时指定的数据锚定日期。为 None 时自动计算。
        stage_callback: 进度回调
        ai_timeout: AI 摘要生成的最大等待秒数，None 使用默认值

    Returns:
        完整的月报告数据字典
    """
    if project_name is None:
        project_name = _resolve_project_name(db, project_ids)
    anchor_date = reference_date if reference_date is not None else _get_report_anchor_date(country)

    # 三个时间窗口
    curr_start, curr_end = _get_report_month(anchor_date)
    prev_start, prev_end = _get_prev_month(curr_start)
    yoy_start, yoy_end = _get_yoy_month(curr_start, curr_end)

    # 1. 月度销售汇总（三窗口）
    current_month = _aggregate_monthly_sales(db, project_ids, country, curr_start, curr_end)
    prev_month = _aggregate_monthly_sales(db, project_ids, country, prev_start, prev_end)
    yoy_month = _aggregate_monthly_sales(db, project_ids, country, yoy_start, yoy_end)

    # 2. 环比 + 同比变化率
    mom_changes = {
        "qty_change": _calc_change_pct(current_month["qty"], prev_month["qty"]),
        "amount_change": _calc_change_pct(current_month["amount"], prev_month["amount"]),
        "avg_price_change": _calc_change_pct(current_month["avg_price"], prev_month["avg_price"]),
    }
    yoy_changes = {
        "qty_change": _calc_change_pct(current_month["qty"], yoy_month["qty"]),
        "amount_change": _calc_change_pct(current_month["amount"], yoy_month["amount"]),
        "avg_price_change": _calc_change_pct(current_month["avg_price"], yoy_month["avg_price"]),
    }

    # 3. SKU 归因分析
    attribution = _analyze_sku_monthly_attribution(
        db, project_ids, country, curr_start, curr_end, prev_start, prev_end, yoy_start, yoy_end,
    )

    # 4. Top SKU 三级对比
    top_skus_comparison = _get_top_skus_monthly_comparison(
        db, project_ids, country, curr_start, curr_end, prev_start, prev_end, yoy_start, yoy_end, limit=10,
    )

    # 5. 库存预警
    inventory_alerts = _get_inventory_alerts(db, project_ids, country)

    # 6. 广告数据对比
    ads_comparison = _get_ads_monthly_comparison(
        db, project_ids, country, curr_start, curr_end, prev_start, prev_end, yoy_start, yoy_end,
    )

    # 7. 退货数据
    returns_data = _get_monthly_returns(
        db, project_ids, country, curr_start, curr_end, current_month.get("qty", 0),
    )

    # 8. 月内周趋势
    weekly_trend = _get_weekly_trend_in_month(db, project_ids, country, curr_start, curr_end)

    # 9. SKU 销售明细
    sku_sales_detail = _query_sku_sales_detail(db, project_ids, country, curr_start, curr_end)

    # 10. 项目背景和 SKU 工厂信息
    project_context, sku_context = fetch_multi_project_context(db, project_ids)
    top_sku_names = [s.get("sku") for s in top_skus_comparison[:8] if s.get("sku")]
    alert_sku_names = [a.get("sku") for a in inventory_alerts[:5] if a.get("sku")]
    relevant_skus = list(dict.fromkeys(top_sku_names + alert_sku_names))
    sku_factory_info_text = fetch_and_format_sku_factory_info(db, relevant_skus, country, project_ids)

    # 11. 异常检测
    anomalies = detect_monthly_anomalies(current_month, prev_month, yoy_month, ads_comparison, returns_data)

    # 12. 构建预警列表（合并异常检测 + 库存预警 + 积极信号）
    alerts = _build_alerts_from_anomalies(anomalies)
    alerts.extend(_build_inventory_alerts(inventory_alerts))
    alerts.extend(_build_positive_signals(top_skus_comparison, ads_comparison))

    # 13. 行动建议
    action_items = generate_monthly_action_items({
        "alerts": alerts,
        "attribution": attribution,
        "inventory_alerts": inventory_alerts,
    })

    # 14. AI 内容生成
    if generate_ai_summary and stage_callback:
        try:
            from app.models.scheduled_report import DeliveryStage
            stage_callback(DeliveryStage.GENERATING_SUMMARY.value)
        except Exception:
            pass

    report_data_for_ai = {
        "project_name": project_name,
        "country": country,
        "current_month": current_month,
        "prev_month": prev_month,
        "yoy_month": yoy_month,
        "mom_changes": mom_changes,
        "yoy_changes": yoy_changes,
        "attribution": attribution,
        "top_skus_comparison": top_skus_comparison,
        "ads_comparison": ads_comparison,
        "returns_data": returns_data,
        "weekly_trend": weekly_trend,
        "alerts": alerts,
        "project_context": project_context,
        "sku_context": sku_context,
        "sku_factory_info_text": sku_factory_info_text,
    }

    ai_summary = generate_monthly_ai_summary(report_data_for_ai, timeout=ai_timeout) if generate_ai_summary else ""

    attribution_summary = generate_monthly_attribution_analysis({
        "attribution": attribution,
        "current_month": current_month,
        "prev_month": prev_month,
    }) if generate_ai_summary else ""

    alert_insights = generate_monthly_alert_insights({"alerts": alerts})

    # 15. 组装最终数据结构
    month_label = f"{curr_start.year}年{curr_start.month}月"

    return {
        # 基本信息
        "project_name": project_name,
        "country": country,
        "month_label": month_label,
        "date_range": _format_date_range(curr_start, curr_end),
        "report_date": anchor_date.isoformat(),
        "report_date_end": curr_end.isoformat(),
        "prev_date_range": _format_date_range(prev_start, prev_end),
        "yoy_date_range": _format_date_range(yoy_start, yoy_end),

        # 本月 / 上月 / 去年同月
        "current_month": current_month,
        "prev_month": prev_month,
        "yoy_month": yoy_month,

        # 变化率
        "mom_changes": mom_changes,
        "yoy_changes": yoy_changes,

        # 归因分析
        "attribution": attribution,
        "attribution_summary": attribution_summary,

        # Top SKU 对比
        "top_skus_comparison": top_skus_comparison,

        # 预警信号
        "alerts": alerts,
        "alert_insights": alert_insights,

        # 行动建议
        "action_items": action_items,

        # 广告对比
        "ads_comparison": ads_comparison,

        # 库存预警
        "inventory_alerts": inventory_alerts,

        # 库存摘要
        "inventory_summary": _get_inventory_summary(db, project_ids, country),

        # 退货数据
        "returns_data": returns_data,

        # 月内周趋势
        "weekly_trend": weekly_trend,

        # SKU 销售明细
        "sku_sales_detail": sku_sales_detail,

        # 项目背景
        "project_context": project_context,
        "sku_context": sku_context,

        # AI 生成内容
        "ai_summary": ai_summary,

        # 仪表板链接
        "dash_url": "https://dash.believeboy.com/dashboard",
    }
