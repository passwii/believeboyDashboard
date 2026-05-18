"""Weekly report data generator."""

from __future__ import annotations

import logging
from datetime import date, timedelta
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models import AnalysisSalesOrderRow, AnalysisSourceFile, InventorySnapshotRow, ScheduledReportSubscription
from app.services.dashboard_overview_service import build_dashboard_overview

logger = logging.getLogger(__name__)


def collect_weekly_report_data(
    db: Session,
    subscription: ScheduledReportSubscription,
) -> dict[str, Any]:
    """收集每周报告所需数据。"""
    project_ids = subscription.project_id_list or None
    country = subscription.country or "US"
    today = date.today()

    week_start = today - timedelta(days=today.weekday())

    overview = build_dashboard_overview(
        db,
        project_ids=project_ids,
        operator=None,
        is_admin=True,
        country=country,
        days=7,
    )

    week_sales = _aggregate_weekly_sales(db, project_ids, country, week_start, today)
    week_ads = overview.get("ads", {})
    top_skus = _get_top_skus_this_week(db, project_ids, country, week_start, today, limit=10)
    inventory_alerts = _get_inventory_alerts(db)

    week_number = today.isocalendar()[1]

    return {
        "report_date": today.isoformat(),
        "week_number": week_number,
        "country": country,
        "project_ids": overview.get("project_ids", []),
        "project_names": overview.get("project_names", []),
        "week_sales": week_sales,
        "week_ads": week_ads,
        "top_skus": top_skus,
        "inventory_alerts": inventory_alerts,
    }


def _aggregate_weekly_sales(
    db: Session,
    project_ids: list[int] | None,
    country: str,
    start_date: date,
    end_date: date,
) -> dict[str, Any]:
    """聚合周销售数据。"""
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
            AnalysisSourceFile.is_current == True,
            AnalysisSalesOrderRow.purchase_date_pt >= start_date,
            AnalysisSalesOrderRow.purchase_date_pt <= end_date,
        )
    )
    if project_ids:
        query = query.filter(AnalysisSourceFile.project_id.in_(project_ids))

    row = query.first()
    return {
        "total_qty": int(row.qty) if row else 0,
        "total_amount": float(row.amount) if row else 0.0,
    }


def _get_top_skus_this_week(
    db: Session,
    project_ids: list[int] | None,
    country: str,
    start_date: date,
    end_date: date,
    limit: int = 10,
) -> list[dict[str, Any]]:
    """获取本周销量最高的 SKU。"""
    query = (
        db.query(
            AnalysisSalesOrderRow.sku,
            func.sum(AnalysisSalesOrderRow.quantity).label("total_qty"),
        )
        .join(AnalysisSourceFile, AnalysisSourceFile.id == AnalysisSalesOrderRow.source_file_id)
        .filter(
            AnalysisSourceFile.country == country,
            AnalysisSourceFile.report_type == "sales_report",
            AnalysisSourceFile.is_current == True,
            AnalysisSalesOrderRow.purchase_date_pt >= start_date,
            AnalysisSalesOrderRow.purchase_date_pt <= end_date,
        )
        .group_by(AnalysisSalesOrderRow.sku)
        .order_by(func.sum(AnalysisSalesOrderRow.quantity).desc())
        .limit(limit)
    )
    if project_ids:
        query = query.filter(AnalysisSourceFile.project_id.in_(project_ids))

    return [{"sku": row.sku or "Unknown", "quantity": int(row.total_qty)} for row in query.all()]


def _get_inventory_alerts(db: Session) -> list[dict[str, Any]]:
    """获取库存预警 SKU（可用库存 <= 10 件）。"""
    query = (
        db.query(InventorySnapshotRow.sku, InventorySnapshotRow.available_qty)
        .filter(InventorySnapshotRow.available_qty <= 10)
        .order_by(InventorySnapshotRow.available_qty.asc())
        .limit(10)
    )
    return [{"sku": row.sku or "Unknown", "available_qty": int(row.available_qty)} for row in query.all()]
