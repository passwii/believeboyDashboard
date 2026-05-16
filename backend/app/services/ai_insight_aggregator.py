from __future__ import annotations

import time
import warnings
from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal
from typing import Any, Callable

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import (
    AnalysisAdProductRow,
    AnalysisSalesOrderRow,
    AnalysisSourceFile,
    InventorySnapshotRow,
    Project,
)
from app.services import project_service
from app.utils.math_utils import round_money, safe_ratio
from app.utils.date_utils import date_range


@dataclass
class AggregatedData:
    project_name: str
    country: str
    date_range_start: date
    date_range_end: date
    sales_by_date: list[dict[str, Any]] = field(default_factory=list)
    ad_by_date: list[dict[str, Any]] = field(default_factory=list)
    inventory_summary: dict[str, Any] = field(default_factory=dict)
    comparison_period: dict[str, Any] | None = None
    top_skus: list[dict[str, Any]] = field(default_factory=list)
    ad_campaigns: list[dict[str, Any]] = field(default_factory=list)
    data_coverage: dict[str, Any] = field(default_factory=dict)
    project_context: dict[str, Any] = field(default_factory=dict)
    sku_context: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "project_name": self.project_name,
            "country": self.country,
            "date_range_start": self.date_range_start.isoformat(),
            "date_range_end": self.date_range_end.isoformat(),
            "sales_by_date": self.sales_by_date,
            "ad_by_date": self.ad_by_date,
            "inventory_summary": self.inventory_summary,
            "comparison_period": self.comparison_period,
            "top_skus": self.top_skus,
            "ad_campaigns": self.ad_campaigns,
            "data_coverage": self.data_coverage,
            "project_context": self.project_context,
            "sku_context": self.sku_context,
        }


# Sub-status values reported during aggregation
AGGREGATE_STEP_SALES = "data_aggregating_sales"
AGGREGATE_STEP_AD = "data_aggregating_ad"
AGGREGATE_STEP_INVENTORY = "data_aggregating_inventory"
AGGREGATE_STEP_COMPARISON_SALES = "data_aggregating_comparison_sales"
AGGREGATE_STEP_COMPARISON_AD = "data_aggregating_comparison_ad"
AGGREGATE_STEP_TOP_SKUS = "data_aggregating_top_skus"
AGGREGATE_STEP_AD_CAMPAIGNS = "data_aggregating_ad_campaigns"


ProgressCallback = Callable[[str, dict[str, Any] | None], None]


# 步骤标签映射
STEP_LABELS: dict[str, str] = {
    AGGREGATE_STEP_SALES: "销售数据",
    AGGREGATE_STEP_AD: "广告数据",
    AGGREGATE_STEP_INVENTORY: "库存快照",
    AGGREGATE_STEP_COMPARISON_SALES: "对比期销售",
    AGGREGATE_STEP_COMPARISON_AD: "对比期广告",
    AGGREGATE_STEP_TOP_SKUS: "Top SKU",
    AGGREGATE_STEP_AD_CAMPAIGNS: "广告活动",
}


def _round_money(value: Decimal) -> float:
    """[已废弃] 请使用 app.shared.math_utils.round_money"""
    warnings.warn(
        "_round_money is deprecated, use app.shared.math_utils.round_money instead",
        DeprecationWarning,
        stacklevel=2,
    )
    return round_money(value)


def _safe_ratio(numerator: Decimal, denominator: int) -> float:
    """[已废弃] 请使用 app.shared.math_utils.safe_ratio"""
    warnings.warn(
        "_safe_ratio is deprecated, use app.shared.math_utils.safe_ratio instead",
        DeprecationWarning,
        stacklevel=2,
    )
    return float(safe_ratio(numerator, denominator))


def _daterange(start_date: date, end_date: date) -> list[date]:
    """[已废弃] 请使用 app.shared.date_utils.date_range"""
    warnings.warn(
        "_daterange is deprecated, use app.shared.date_utils.date_range instead",
        DeprecationWarning,
        stacklevel=2,
    )
    return date_range(start_date, end_date)


def _get_project_or_404(db: Session, project_id: int) -> Project | None:
    row = db.get(Project, project_id)
    return row


def _report(
    progress_cb: ProgressCallback | None,
    step: str,
    detail_data: dict[str, Any] | None = None,
    min_display_ms: int = 600,
) -> None:
    """报告进度，确保每个步骤至少显示 min_display_ms 毫秒
    
    Args:
        progress_cb: 进度回调函数
        step: 步骤标识
        detail_data: 详细数据，会被传递给回调
        min_display_ms: 最小显示时间（毫秒），让用户能看清每个步骤
    """
    start_time = time.time()
    
    if progress_cb:
        progress_cb(step, detail_data)
    
    # 计算已耗时，如果太短则延迟
    elapsed_ms = (time.time() - start_time) * 1000
    if elapsed_ms < min_display_ms:
        time.sleep((min_display_ms - elapsed_ms) / 1000)


def aggregate_project_data(
    db: Session,
    project_id: int,
    country: str,
    start_date: date,
    end_date: date,
    progress_cb: ProgressCallback | None = None,
) -> AggregatedData | None:
    project = _get_project_or_404(db, project_id)
    if project is None:
        return None

    # Compute comparison period dates
    period_days = (end_date - start_date).days + 1
    comp_end = start_date - timedelta(days=1)
    comp_start = comp_end - timedelta(days=period_days - 1)

    from app.db.session import SessionLocal
    session_factory = SessionLocal

    # Run queries sequentially so progress events are ordered and visible.
    # Each query sends a "running" event before executing and a "completed"
    # event with detail data after, giving the user clear step-by-step feedback.

    sales_by_date, sales_coverage = _aggregate_sales_by_date_sql(
        session_factory, project_id, country, start_date, end_date,
        AGGREGATE_STEP_SALES, progress_cb,
    )

    ad_by_date, ad_coverage = _aggregate_ad_by_date_sql(
        session_factory, project_id, country, start_date, end_date,
        AGGREGATE_STEP_AD, progress_cb,
    )

    inventory_summary = _aggregate_inventory_summary(
        session_factory, project_id, country, end_date,
        AGGREGATE_STEP_INVENTORY, progress_cb,
    )

    top_skus = _get_top_skus_sql(
        session_factory, project_id, country, start_date, end_date,
        AGGREGATE_STEP_TOP_SKUS, progress_cb,
    )

    comp_sales_result, _ = _aggregate_sales_by_date_sql(
        session_factory, project_id, country, comp_start, comp_end,
        AGGREGATE_STEP_COMPARISON_SALES, progress_cb,
    )

    comp_ad_result, _ = _aggregate_ad_by_date_sql(
        session_factory, project_id, country, comp_start, comp_end,
        AGGREGATE_STEP_COMPARISON_AD, progress_cb,
    )

    ad_campaigns = _get_ad_campaign_summary_sql(
        session_factory, project_id, country, start_date, end_date,
        AGGREGATE_STEP_AD_CAMPAIGNS, progress_cb,
    )

    # Fetch project context
    project_context, sku_context = project_service.get_project_context(db, project_id)

    # Build comparison period summary
    total_comp_sales = sum(r["sales_amount"] for r in comp_sales_result)
    total_comp_orders = sum(r["order_qty"] for r in comp_sales_result)
    total_comp_ad_spend = sum(r["ad_spend"] for r in comp_ad_result)
    total_comp_ad_sales = sum(r["ad_sales"] for r in comp_ad_result)

    comparison_period = {
        "period_start": comp_start.isoformat(),
        "period_end": comp_end.isoformat(),
        "period_days": period_days,
        "total_sales": round(total_comp_sales, 2),
        "total_orders": total_comp_orders,
        "total_ad_spend": round(total_comp_ad_spend, 2),
        "total_ad_sales": round(total_comp_ad_sales, 2),
    }

    return AggregatedData(
        project_name=project.project_name,
        country=country,
        date_range_start=start_date,
        date_range_end=end_date,
        sales_by_date=sales_by_date,
        ad_by_date=ad_by_date,
        inventory_summary=inventory_summary,
        comparison_period=comparison_period,
        top_skus=top_skus,
        ad_campaigns=ad_campaigns,
        data_coverage={
            "sales_days": sales_coverage["days"],
            "ad_days": ad_coverage["days"],
            "total_requested_days": len(_daterange(start_date, end_date)),
        },
        project_context=project_context or {},
        sku_context=sku_context or {},
    )


# --- SQL-side aggregation (avoids pulling millions of rows into Python) ---


def _aggregate_sales_by_date_sql(
    session_factory,
    project_id: int,
    country: str,
    start_date: date,
    end_date: date,
    step: str,
    progress_cb: ProgressCallback | None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    db = session_factory()
    try:
        # 先报告开始状态
        _report(progress_cb, step, {
            "step_label": STEP_LABELS.get(step, step),
            "status": "running",
            "message": "正在连接数据库...",
        })
        
        # Aggregate at SQL level — only returns one row per date, not one row per order
        stmt = (
            select(
                AnalysisSourceFile.report_date,
                func.sum(AnalysisSalesOrderRow.quantity).label("order_qty"),
                func.sum(AnalysisSalesOrderRow.item_price).label("sales_amount"),
                func.count(func.distinct(AnalysisSalesOrderRow.asin)).label(
                    "unique_asins"
                ),
            )
            .select_from(AnalysisSourceFile)
            .join(
                AnalysisSalesOrderRow,
                AnalysisSalesOrderRow.source_file_id == AnalysisSourceFile.id,
            )
            .where(
                AnalysisSourceFile.project_id == project_id,
                AnalysisSourceFile.report_type == "sales_report",
                AnalysisSourceFile.country == country,
                AnalysisSourceFile.is_current.is_(True),
                AnalysisSourceFile.report_date.is_not(None),
                AnalysisSourceFile.report_date >= start_date,
                AnalysisSourceFile.report_date <= end_date,
                AnalysisSalesOrderRow.is_counted_sales.is_(True),
            )
            .group_by(AnalysisSourceFile.report_date)
            .order_by(AnalysisSourceFile.report_date)
        )
        rows = db.execute(stmt).all()

        result = []
        for report_date, order_qty, sales_amount, unique_asins in rows:
            if report_date is None:
                continue
            result.append(
                {
                    "date": report_date.isoformat(),
                    "order_qty": int(order_qty or 0),
                    "sales_amount": _round_money(Decimal(str(sales_amount or 0))),
                    "unique_asins": int(unique_asins or 0),
                }
            )

        # 计算统计数据
        total_sales = sum(r["sales_amount"] for r in result)
        total_orders = sum(r["order_qty"] for r in result)
        days_count = len(set(r["date"] for r in result))
        
        # 报告完成状态（带详细数据）
        _report(progress_cb, step, {
            "step_label": STEP_LABELS.get(step, step),
            "status": "completed",
            "record_count": len(result),
            "days_count": days_count,
            "total_amount": total_sales,
            "total_orders": total_orders,
            "message": f"获取到 {days_count} 天销售数据",
        })

        return result, {"days": days_count}
    finally:
        db.close()


def _aggregate_ad_by_date_sql(
    session_factory,
    project_id: int,
    country: str,
    start_date: date,
    end_date: date,
    step: str,
    progress_cb: ProgressCallback | None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    db = session_factory()
    try:
        # 先报告开始状态
        _report(progress_cb, step, {
            "step_label": STEP_LABELS.get(step, step),
            "status": "running",
            "message": "正在查询广告数据...",
        })
        
        stmt = (
            select(
                AnalysisSourceFile.report_date,
                func.sum(AnalysisAdProductRow.impressions).label("impressions"),
                func.sum(AnalysisAdProductRow.clicks).label("clicks"),
                func.sum(AnalysisAdProductRow.spend).label("ad_spend"),
                func.sum(AnalysisAdProductRow.sales_7d).label("ad_sales"),
                func.sum(AnalysisAdProductRow.orders_7d).label("ad_orders"),
            )
            .select_from(AnalysisSourceFile)
            .join(
                AnalysisAdProductRow,
                AnalysisAdProductRow.source_file_id == AnalysisSourceFile.id,
            )
            .where(
                AnalysisSourceFile.project_id == project_id,
                AnalysisSourceFile.report_type == "ad_product_report",
                AnalysisSourceFile.country == country,
                AnalysisSourceFile.is_current.is_(True),
                AnalysisSourceFile.report_date.is_not(None),
                AnalysisSourceFile.report_date >= start_date,
                AnalysisSourceFile.report_date <= end_date,
                AnalysisAdProductRow.scope_status == "included_product",
            )
            .group_by(AnalysisSourceFile.report_date)
            .order_by(AnalysisSourceFile.report_date)
        )
        rows = db.execute(stmt).all()

        result = []
        for report_date, impressions, clicks, ad_spend, ad_sales, ad_orders in rows:
            if report_date is None:
                continue
            clicks_int = int(clicks or 0)
            impressions_int = int(impressions or 0)
            result.append(
                {
                    "date": report_date.isoformat(),
                    "impressions": impressions_int,
                    "clicks": clicks_int,
                    "ad_spend": _round_money(Decimal(str(ad_spend or 0))),
                    "ad_sales": _round_money(Decimal(str(ad_sales or 0))),
                    "ad_orders": int(ad_orders or 0),
                    "ctr": round(
                        _safe_ratio(Decimal(str(clicks_int)), impressions_int) * 100, 2
                    ),
                    "roas": round(
                        _safe_ratio(
                            Decimal(str(ad_sales or 0)), Decimal(str(ad_spend or 0))
                        ),
                        2,
                    ),
                }
            )

        # 计算统计数据
        total_ad_spend = sum(r["ad_spend"] for r in result)
        total_ad_sales = sum(r["ad_sales"] for r in result)
        total_impressions = sum(r["impressions"] for r in result)
        days_count = len(set(r["date"] for r in result))
        
        # 报告完成状态（带详细数据）
        _report(progress_cb, step, {
            "step_label": STEP_LABELS.get(step, step),
            "status": "completed",
            "record_count": len(result),
            "days_count": days_count,
            "total_amount": total_ad_spend,
            "total_ad_sales": total_ad_sales,
            "total_impressions": total_impressions,
            "message": f"获取到 {days_count} 天广告数据",
        })

        return result, {"days": days_count}
    finally:
        db.close()


def _aggregate_inventory_summary(
    session_factory,
    project_id: int,
    country: str,
    as_of_date: date,
    step: str,
    progress_cb: ProgressCallback | None,
) -> dict[str, Any]:
    db = session_factory()
    try:
        # 先报告开始状态
        _report(progress_cb, step, {
            "step_label": STEP_LABELS.get(step, step),
            "status": "running",
            "message": "正在查询库存快照...",
        })

        # Use report_date (the business date) for ordering and filtering.
        # Old rows with report_date=NULL retain the upload-time snapshot_at value,
        # which would sort above the correct business-date rows — exclude them.
        stmt = (
            select(AnalysisSourceFile)
            .where(
                AnalysisSourceFile.project_id == project_id,
                AnalysisSourceFile.report_type == "inventory_report",
                AnalysisSourceFile.country == country,
                AnalysisSourceFile.report_date.isnot(None),
                AnalysisSourceFile.report_date <= as_of_date,
            )
            .order_by(
                AnalysisSourceFile.report_date.desc(),
                AnalysisSourceFile.version.desc(),
                AnalysisSourceFile.id.desc(),
            )
            .limit(1)
        )
        source = db.execute(stmt).scalar_one_or_none()

        if source is None:
            _report(progress_cb, step, {
                "step_label": STEP_LABELS.get(step, step),
                "status": "completed",
                "record_count": 0,
                "message": "未找到库存数据",
            })
            return {"available": 0, "out_of_stock_skus": [], "aging_summary": {}}

        source_id = int(source.id)

        # Aggregate inventory in SQL
        inv_stmt = select(
            func.sum(InventorySnapshotRow.available_qty).label("total_available"),
            func.count(
                func.nullif(
                    (InventorySnapshotRow.stock_status == "out_of_stock")
                    | (InventorySnapshotRow.available_qty == 0),
                    False,
                )
            ).label("out_of_stock_count"),
            func.sum(InventorySnapshotRow.age_0_90_qty).label("age_0_90"),
            func.sum(InventorySnapshotRow.age_91_180_qty).label("age_91_180"),
            func.sum(InventorySnapshotRow.age_181_270_qty).label("age_181_270"),
            func.sum(InventorySnapshotRow.age_271_365_qty).label("age_271_365"),
            func.sum(InventorySnapshotRow.age_365_plus_qty).label("age_365_plus"),
        ).where(InventorySnapshotRow.source_file_id == source_id)

        agg = db.execute(inv_stmt).one()

        # Get out-of-stock SKUs (only up to 20)
        oos_stmt = (
            select(InventorySnapshotRow.sku)
            .where(
                InventorySnapshotRow.source_file_id == source_id,
                (InventorySnapshotRow.stock_status == "out_of_stock")
                | (InventorySnapshotRow.available_qty == 0),
            )
            .limit(20)
        )
        out_of_stock = [row[0] for row in db.execute(oos_stmt).all()]

        aging_total = {
            "0-90": int(agg.age_0_90 or 0),
            "91-180": int(agg.age_91_180 or 0),
            "181-270": int(agg.age_181_270 or 0),
            "271-365": int(agg.age_271_365 or 0),
            "365+": int(agg.age_365_plus or 0),
        }

        total_available = int(agg.total_available or 0)
        out_of_stock_count = int(agg.out_of_stock_count or 0)

        # 报告完成状态（带详细数据）
        _report(progress_cb, step, {
            "step_label": STEP_LABELS.get(step, step),
            "status": "completed",
            "record_count": total_available,
            "out_of_stock_count": out_of_stock_count,
            "data_preview": {
                "available": total_available,
                "out_of_stock": out_of_stock_count,
                "aging": aging_total,
            },
            "message": f"可用库存 {total_available}，缺货 {out_of_stock_count} SKU",
        })

        return {
            "available": total_available,
            "out_of_stock_skus": out_of_stock,
            "out_of_stock_count": out_of_stock_count,
            "aging_summary": aging_total,
            "snapshot_date": (
                source.snapshot_at.isoformat()
                if source.snapshot_at
                else source.report_date.isoformat()
                if source.report_date
                else None
            ),
        }
    finally:
        db.close()


def _get_top_skus_sql(
    session_factory,
    project_id: int,
    country: str,
    start_date: date,
    end_date: date,
    step: str,
    progress_cb: ProgressCallback | None,
) -> list[dict[str, Any]]:
    db = session_factory()
    try:
        # 先报告开始状态
        _report(progress_cb, step, {
            "step_label": STEP_LABELS.get(step, step),
            "status": "running",
            "message": "正在统计 TOP SKU...",
        })
        
        stmt = (
            select(
                AnalysisSalesOrderRow.sku,
                func.max(AnalysisSalesOrderRow.asin).label("asin"),
                func.sum(AnalysisSalesOrderRow.quantity).label("order_qty"),
                func.sum(AnalysisSalesOrderRow.item_price).label("sales_amount"),
            )
            .select_from(AnalysisSourceFile)
            .join(
                AnalysisSalesOrderRow,
                AnalysisSalesOrderRow.source_file_id == AnalysisSourceFile.id,
            )
            .where(
                AnalysisSourceFile.project_id == project_id,
                AnalysisSourceFile.report_type == "sales_report",
                AnalysisSourceFile.country == country,
                AnalysisSourceFile.is_current.is_(True),
                AnalysisSourceFile.report_date.is_not(None),
                AnalysisSourceFile.report_date >= start_date,
                AnalysisSourceFile.report_date <= end_date,
                AnalysisSalesOrderRow.is_counted_sales.is_(True),
                AnalysisSalesOrderRow.sku.is_not(None),
            )
            .group_by(AnalysisSalesOrderRow.sku)
            .order_by(func.sum(AnalysisSalesOrderRow.item_price).desc())
            .limit(10)
        )
        rows = db.execute(stmt).all()

        result = [
            {
                "sku": (sku or "").strip(),
                "asin": asin,
                "order_qty": int(order_qty or 0),
                "sales_amount": _round_money(Decimal(str(sales_amount or 0))),
            }
            for sku, asin, order_qty, sales_amount in rows
        ]

        # 准备数据预览（前3个SKU）
        data_preview = [
            {"sku": item["sku"], "sales_amount": item["sales_amount"], "order_qty": item["order_qty"]}
            for item in result[:3]
        ]

        # 报告完成状态（带详细数据）
        _report(progress_cb, step, {
            "step_label": STEP_LABELS.get(step, step),
            "status": "completed",
            "record_count": len(result),
            "data_preview": data_preview,
            "message": f"获取到 {len(result)} 个 SKU",
        })

        return result
    finally:
        db.close()


def _get_ad_campaign_summary_sql(
    session_factory,
    project_id: int,
    country: str,
    start_date: date,
    end_date: date,
    step: str,
    progress_cb: ProgressCallback | None,
) -> list[dict[str, Any]]:
    db = session_factory()
    try:
        # 先报告开始状态
        _report(progress_cb, step, {
            "step_label": STEP_LABELS.get(step, step),
            "status": "running",
            "message": "正在汇总广告活动数据...",
        })
        
        stmt = (
            select(
                AnalysisSourceFile.report_date,
                func.sum(AnalysisAdProductRow.impressions).label("impressions"),
                func.sum(AnalysisAdProductRow.clicks).label("clicks"),
                func.sum(AnalysisAdProductRow.spend).label("ad_spend"),
                func.sum(AnalysisAdProductRow.sales_7d).label("ad_sales"),
                func.sum(AnalysisAdProductRow.orders_7d).label("ad_orders"),
            )
            .select_from(AnalysisSourceFile)
            .join(
                AnalysisAdProductRow,
                AnalysisAdProductRow.source_file_id == AnalysisSourceFile.id,
            )
            .where(
                AnalysisSourceFile.project_id == project_id,
                AnalysisSourceFile.report_type == "ad_product_report",
                AnalysisSourceFile.country == country,
                AnalysisSourceFile.is_current.is_(True),
                AnalysisSourceFile.report_date.is_not(None),
                AnalysisSourceFile.report_date >= start_date,
                AnalysisSourceFile.report_date <= end_date,
                AnalysisAdProductRow.scope_status == "included_product",
            )
            .group_by(AnalysisSourceFile.report_date)
            .order_by(AnalysisSourceFile.report_date)
        )
        rows = db.execute(stmt).all()

        result = [
            {
                "date": (report_date or date.min).isoformat(),
                "impressions": int(impressions or 0),
                "clicks": int(clicks or 0),
                "ad_spend": _round_money(Decimal(str(ad_spend or 0))),
                "ad_sales": _round_money(Decimal(str(ad_sales or 0))),
                "ad_orders": int(ad_orders or 0),
            }
            for (
                report_date,
                impressions,
                clicks,
                ad_spend,
                ad_sales,
                ad_orders,
            ) in rows
        ]

        # 计算统计数据
        total_ad_spend = sum(r["ad_spend"] for r in result)
        total_ad_sales = sum(r["ad_sales"] for r in result)
        total_impressions = sum(r["impressions"] for r in result)

        # 报告完成状态（带详细数据）
        _report(progress_cb, step, {
            "step_label": STEP_LABELS.get(step, step),
            "status": "completed",
            "record_count": len(result),
            "total_amount": total_ad_spend,
            "total_ad_sales": total_ad_sales,
            "total_impressions": total_impressions,
            "message": f"获取到 {len(result)} 天广告活动数据",
        })

        return result
    finally:
        db.close()
