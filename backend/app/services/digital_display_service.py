"""数字大屏数据聚合服务"""

from __future__ import annotations

import json
import warnings
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import (
    AdUploadFile,
    AdUploadCampaignRow,
    AnalysisAdProductRow,
    AnalysisBusinessRow,
    AnalysisSourceFile,
    AnalysisSalesOrderRow,
    InventorySnapshotRow,
    Project,
    ReturnAnalysisRecord,
    ShipmentSchedule,
    ShipmentScheduleItem,
)
from app.utils.math_utils import round_money
from app.utils.country import normalize_country


# ─── helpers ─────────────────────────────────────────────────────────────────

def _round_money(value: Decimal) -> float:
    """[已废弃] 请使用 app.shared.math_utils.round_money"""
    warnings.warn(
        "_round_money is deprecated, use app.shared.math_utils.round_money instead",
        DeprecationWarning,
        stacklevel=2,
    )
    return round_money(value)


def _safe_rate(numerator: float, denominator: float) -> float:
    if denominator <= 0:
        return 0.0
    return round(numerator / denominator * 100, 2)


# ─── cache key / helpers ─────────────────────────────────────────────────────

def _cache_key(project_id: int, country: str, days: int) -> str:
    return f"digital_display:{project_id}:{country}:{days}"


# ─── sales snapshot ──────────────────────────────────────────────────────────

def _build_sales_snapshot(
    db: Session,
    project_id: int,
    country: str,
    today: date,
    days: int,
) -> dict:
    """今日销售 + 7日趋势 + 环比"""
    prev_end = today - timedelta(days=1)
    prev_start = prev_end - timedelta(days=days - 1)

    # build summaries for current and previous period
    def _period_summary(start: date, end: date) -> dict:
        start_str = start.isoformat()
        end_str = end.isoformat()

        # sales
        sales_rows = (
            db.query(
                func.coalesce(func.sum(AnalysisSalesOrderRow.quantity), 0).label("qty"),
                func.coalesce(func.sum(
                    func.coalesce(AnalysisSalesOrderRow.item_price, 0) +
                    func.coalesce(AnalysisSalesOrderRow.shipping_price, 0)
                ), 0).label("amount"),
            )
            .join(
                AnalysisSourceFile,
                AnalysisSourceFile.id == AnalysisSalesOrderRow.source_file_id,
            )
            .filter(
                AnalysisSourceFile.project_id == project_id,
                AnalysisSourceFile.country == country,
                AnalysisSourceFile.report_type == "sales_report",
                AnalysisSourceFile.is_current == True,
                AnalysisSalesOrderRow.is_counted_sales == True,
                AnalysisSalesOrderRow.purchase_date_pt >= start,
                AnalysisSalesOrderRow.purchase_date_pt <= end,
            )
            .first()
        )

        # sessions from business report (aggregated at source file level, not per-day)
        biz_rows = (
            db.query(
                func.coalesce(func.sum(AnalysisBusinessRow.sessions), 0).label("sessions"),
                func.coalesce(func.sum(AnalysisBusinessRow.ordered_sales_amount), 0).label("sales"),
            )
            .join(
                AnalysisSourceFile,
                AnalysisSourceFile.id == AnalysisBusinessRow.source_file_id,
            )
            .filter(
                AnalysisSourceFile.project_id == project_id,
                AnalysisSourceFile.country == country,
                AnalysisSourceFile.report_type == "business_report",
                AnalysisSourceFile.is_current == True,
            )
            .first()
        )
        total_sessions = int(biz_rows.sessions or 0)
        total_sales = float(biz_rows.sales or 0)

        return {
            "order_qty": int(sales_rows.qty or 0),
            "sales_amount": _round_money(Decimal(str(sales_rows.amount or 0))),
            "sessions": total_sessions,
            "ordered_sales_amount": round(total_sales, 2),
        }

    today_summary = _period_summary(today, today)
    yesterday_summary = _period_summary(prev_end, prev_end)  # 真正的昨日单日数据
    prev_summary = _period_summary(prev_start, prev_end)

    # trend: daily breakdown for the past `days` days
    trend_rows: list[dict] = []
    for offset in range(days - 1, -1, -1):
        d = today - timedelta(days=offset)
        day_summary = _period_summary(d, d)
        trend_rows.append({
            "date": d.isoformat(),
            "order_qty": day_summary["order_qty"],
            "sales_amount": day_summary["sales_amount"],
            "sessions": day_summary["sessions"],
        })

    # 计算单日环比：今日 vs 昨日
    yesterday_qty = yesterday_summary["order_qty"]
    yesterday_amount = yesterday_summary["sales_amount"]
    if yesterday_qty > 0:
        daily_qty_change_pct = ((today_summary["order_qty"] - yesterday_qty) / yesterday_qty) * 100
    else:
        daily_qty_change_pct = 0.0
    if yesterday_amount > 0:
        daily_amount_change_pct = ((today_summary["sales_amount"] - yesterday_amount) / yesterday_amount) * 100
    else:
        daily_amount_change_pct = 0.0

    return {
        "today_order_qty": today_summary["order_qty"],
        "today_sales_amount": today_summary["sales_amount"],
        "today_sessions": today_summary["sessions"],
        "today_ordered_sales_amount": today_summary["ordered_sales_amount"],
        "yesterday_order_qty": yesterday_qty,
        "yesterday_sales_amount": yesterday_amount,
        "daily_qty_change_pct": round(daily_qty_change_pct, 2),
        "daily_amount_change_pct": round(daily_amount_change_pct, 2),
        "prev_order_qty": prev_summary["order_qty"],
        "prev_sales_amount": prev_summary["sales_amount"],
        "prev_sessions": prev_summary["sessions"],
        "trend": trend_rows,
    }


# ─── inventory snapshot ──────────────────────────────────────────────────────

def _build_inventory_snapshot(
    db: Session,
    project_id: int,
    country: str,
) -> dict:
    """当前库存概况：SKU数、缺货数、总可用库存"""
    # Get latest inventory snapshot source
    latest = (
        db.query(AnalysisSourceFile.id)
        .filter(
            AnalysisSourceFile.project_id == project_id,
            AnalysisSourceFile.country == country,
            AnalysisSourceFile.report_type == "inventory_report",
            AnalysisSourceFile.is_current == True,
        )
        .order_by(AnalysisSourceFile.report_date.desc().nullslast(), AnalysisSourceFile.snapshot_at.desc().nullslast())
        .first()
    )

    if latest is None:
        return {
            "sku_count": 0,
            "out_of_stock_count": 0,
            "available_qty": 0,
        }

    rows = (
        db.query(
            func.count(func.distinct(InventorySnapshotRow.sku)).label("sku_count"),
            func.coalesce(func.sum(InventorySnapshotRow.available_qty), 0).label("total_qty"),
        )
        .filter(InventorySnapshotRow.source_file_id == int(latest[0]))
        .first()
    )

    out_of_stock_rows = (
        db.query(func.count(func.distinct(InventorySnapshotRow.sku)).label("cnt"))
        .filter(
            InventorySnapshotRow.source_file_id == int(latest[0]),
            InventorySnapshotRow.available_qty <= 0,
        )
        .scalar() or 0
    )

    return {
        "sku_count": int(rows.sku_count or 0),
        "out_of_stock_count": int(out_of_stock_rows or 0),
        "available_qty": int(rows.total_qty or 0),
    }


# ─── shipment snapshot ────────────────────────────────────────────────────────

def _build_shipment_snapshot(
    db: Session,
    project_id: int,
    country: str,
) -> dict:
    """发货在途概况：批次数量、总数量"""
    # Count schedules (batches)
    count_row = (
        db.query(func.count(ShipmentSchedule.id))
        .filter(
            ShipmentSchedule.project_id == project_id,
            ShipmentSchedule.country == normalize_country(country),
            ShipmentSchedule.shipment_status == "in_transit",
        )
        .scalar() or 0
    )

    # Sum quantities from items
    qty_row = (
        db.query(func.coalesce(func.sum(ShipmentScheduleItem.quantity), 0))
        .join(
            ShipmentSchedule,
            ShipmentSchedule.id == ShipmentScheduleItem.shipment_schedule_id,
        )
        .filter(
            ShipmentSchedule.project_id == project_id,
            ShipmentSchedule.country == normalize_country(country),
            ShipmentSchedule.shipment_status == "in_transit",
        )
        .scalar() or 0
    )

    return {
        "in_transit_count": int(count_row),
        "in_transit_qty": int(qty_row),
    }


# ─── return snapshot ───────────────────────────────────────────────────────────

def _build_return_snapshot(
    db: Session,
    project_id: int,
    country: str,
    start_date: date,
    end_date: date,
) -> dict:
    """最近N天退货概况：总退货数、退货率、top退货原因"""
    total_returns = (
        db.query(func.count(ReturnAnalysisRecord.id))
        .filter(
            ReturnAnalysisRecord.project_id == project_id,
            ReturnAnalysisRecord.country == normalize_country(country),
            ReturnAnalysisRecord.is_current == True,
            ReturnAnalysisRecord.return_date >= start_date.isoformat(),
            ReturnAnalysisRecord.return_date <= end_date.isoformat(),
        )
        .scalar() or 0
    )

    total_quantity = (
        db.query(func.coalesce(func.sum(ReturnAnalysisRecord.quantity), 0))
        .filter(
            ReturnAnalysisRecord.project_id == project_id,
            ReturnAnalysisRecord.country == normalize_country(country),
            ReturnAnalysisRecord.is_current == True,
            ReturnAnalysisRecord.return_date >= start_date.isoformat(),
            ReturnAnalysisRecord.return_date <= end_date.isoformat(),
        )
        .scalar() or 0
    )

    # top reason
    reason_row = (
        db.query(
            ReturnAnalysisRecord.reason,
            func.count(ReturnAnalysisRecord.id).label("cnt"),
        )
        .filter(
            ReturnAnalysisRecord.project_id == project_id,
            ReturnAnalysisRecord.country == normalize_country(country),
            ReturnAnalysisRecord.is_current == True,
            ReturnAnalysisRecord.return_date >= start_date.isoformat(),
            ReturnAnalysisRecord.return_date <= end_date.isoformat(),
        )
        .group_by(ReturnAnalysisRecord.reason)
        .order_by(func.count(ReturnAnalysisRecord.id).desc())
        .first()
    )

    # sales qty for return rate
    sales_qty = (
        db.query(func.coalesce(func.sum(AnalysisSalesOrderRow.quantity), 0))
        .join(
            AnalysisSourceFile,
            AnalysisSourceFile.id == AnalysisSalesOrderRow.source_file_id,
        )
        .filter(
            AnalysisSourceFile.project_id == project_id,
            AnalysisSourceFile.country == normalize_country(country),
            AnalysisSourceFile.report_type == "sales_report",
            AnalysisSourceFile.is_current == True,
            AnalysisSalesOrderRow.is_counted_sales == True,
            AnalysisSalesOrderRow.purchase_date_pt >= start_date,
            AnalysisSalesOrderRow.purchase_date_pt <= end_date,
        )
        .scalar() or 0
    )

    return_rate = _safe_rate(float(total_quantity), float(sales_qty))

    from app.constants.return_translations import translate_return_field
    top_reason = translate_return_field("reason", reason_row[0]) if reason_row else None

    return {
        "total_returns": int(total_returns),
        "total_quantity": int(total_quantity),
        "return_rate": return_rate,
        "top_reason": top_reason,
    }


# ─── ad snapshot ──────────────────────────────────────────────────────────────

def _build_ad_snapshot(
    db: Session,
    project_id: int,
    country: str,
    start_date: date,
    end_date: date,
) -> dict:
    """最近N天广告概况：花费、ROAS、ACOS、CTR（数据来源：analysis_ad_product_rows）"""
    rows = (
        db.query(
            func.coalesce(func.sum(AnalysisAdProductRow.spend), 0).label("spend"),
            func.coalesce(func.sum(AnalysisAdProductRow.sales_7d), 0).label("sales"),
            func.coalesce(func.sum(AnalysisAdProductRow.clicks), 0).label("clicks"),
            func.coalesce(func.sum(AnalysisAdProductRow.impressions), 0).label("impressions"),
            func.coalesce(func.sum(AnalysisAdProductRow.orders_7d), 0).label("orders"),
        )
        .join(
            AnalysisSourceFile,
            AnalysisSourceFile.id == AnalysisAdProductRow.source_file_id,
        )
        .filter(
            AnalysisSourceFile.project_id == project_id,
            AnalysisSourceFile.country == normalize_country(country),
            AnalysisSourceFile.report_type == "ad_product_report",
            AnalysisSourceFile.is_current == True,
            AnalysisSourceFile.period_end_date >= start_date,
            AnalysisSourceFile.period_end_date <= end_date,
        )
        .first()
    )

    spend = float(rows.spend or 0)
    sales = float(rows.sales or 0)
    clicks = int(rows.clicks or 0)
    impressions = int(rows.impressions or 0)
    orders = int(rows.orders or 0)

    roas = round(sales / spend, 2) if spend > 0 else 0.0
    acos = round(spend / sales * 100, 2) if sales > 0 else 0.0
    ctr = round(clicks / impressions * 100, 2) if impressions > 0 else 0.0

    return {
        "period_spend": round(spend, 2),
        "period_sales": round(sales, 2),
        "period_roas": roas,
        "period_acos": acos,
        "period_ctr": ctr,
        "period_impressions": impressions,
        "period_clicks": clicks,
        "period_orders": orders,
    }


# ─── main builder ─────────────────────────────────────────────────────────────

def build_digital_display(
    db: Session,
    project_id: int,
    country: str = "US",
    days: int = 7,
) -> dict:
    """
    聚合所有大屏数据到单一响应。
    数据来自各已有服务，无 Redis 缓存（TV 轮询频率低，数据新鲜度优先）。
    如需缓存，在调用方层加 Redis，TTL=60s。
    """
    project = db.get(Project, project_id)
    if project is None:
        from fastapi import HTTPException, status
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")

    normalized_country = normalize_country(country)
    today = date.today()
    period_start = today - timedelta(days=days - 1)

    sales = _build_sales_snapshot(db, project_id, normalized_country, today, days)
    inventory = _build_inventory_snapshot(db, project_id, normalized_country)
    shipments = _build_shipment_snapshot(db, project_id, normalized_country)
    returns = _build_return_snapshot(db, project_id, normalized_country, period_start, today)
    ads = _build_ad_snapshot(db, project_id, normalized_country, period_start, today)

    return {
        "project_id": int(project.id),
        "project_name": project.project_name,
        "country": normalized_country,
        "server_time": str(today),
        "sales": {
            "today_order_qty": sales["today_order_qty"],
            "today_sales_amount": sales["today_sales_amount"],
            "today_sessions": sales["today_sessions"],
            "today_ordered_sales_amount": sales["today_ordered_sales_amount"],
            "prev_order_qty": sales["prev_order_qty"],
            "prev_sales_amount": sales["prev_sales_amount"],
            "prev_sessions": sales["prev_sessions"],
        },
        "sales_trend": sales["trend"],
        "inventory": inventory,
        "shipments": shipments,
        "returns": returns,
        "ads": ads,
    }