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
    AdUploadBudgetRow,
    AdUploadCampaignRow,
    AdUploadFile,
    AdUploadInvalidTrafficRow,
    AdUploadPlacementRow,
    AdUploadPromotedProductRow,
    AdUploadPurchasedProductRow,
    AdUploadSearchTermRow,
    AdUploadSearchTermShareRow,
    AdUploadTargetRow,
    AdUploadTimeTrendRow,
    AnalysisSalesOrderRow,
    AnalysisSourceFile,
    InventorySnapshotRow,
    Project,
)
from app.services import project_service
from app.utils.math_utils import round_money, safe_ratio
from app.utils.date_utils import date_range
from app.utils.sales_amount import sales_amount_expr


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
    # ad_breakdown_by_type: 10 种 ad 报表类型各自聚合的指标，供 ad_analysis 模式使用。
    # 结构: { report_type: { "summary": {...}, "top": [...], "...": ... } }
    ad_breakdown_by_type: dict[str, dict[str, Any]] = field(default_factory=dict)
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
            "ad_breakdown_by_type": self.ad_breakdown_by_type,
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

    from app.db.session import ReadSessionLocal, SessionLocal
    # BEL-55-P5 / BEL-73: when a read replica is configured, the read-only
    # sub-sessions opened inside this aggregator route to it. When the
    # replica is not configured, `ReadSessionLocal` is None and we fall
    # back to `SessionLocal` (unchanged behavior — backward compatible).
    session_factory = ReadSessionLocal or SessionLocal

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

    # 10 种 ad 报表类型的全量聚合 (给 ad_analysis 模式用)
    ad_breakdown_by_type = _aggregate_ad_breakdown_by_type_sql(
        session_factory, project_id, country, start_date, end_date,
        progress_cb,
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
        ad_breakdown_by_type=ad_breakdown_by_type,
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
                func.sum(sales_amount_expr(country)).label("sales_amount"),
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
                AdUploadFile.report_date,
                func.sum(AdUploadPromotedProductRow.impressions).label("impressions"),
                func.sum(AdUploadPromotedProductRow.clicks).label("clicks"),
                func.sum(AdUploadPromotedProductRow.spend).label("ad_spend"),
                func.sum(AdUploadPromotedProductRow.sales_7d).label("ad_sales"),
                func.sum(AdUploadPromotedProductRow.orders_7d).label("ad_orders"),
            )
            .select_from(AdUploadFile)
            .join(
                AdUploadPromotedProductRow,
                AdUploadPromotedProductRow.source_file_id == AdUploadFile.id,
            )
            .where(
                AdUploadFile.project_id == project_id,
                AdUploadFile.report_type == "ad_promoted_product_report",
                AdUploadFile.country == country,
                AdUploadFile.is_current.is_(True),
                AdUploadFile.report_date.is_not(None),
                AdUploadFile.report_date >= start_date,
                AdUploadFile.report_date <= end_date,
                AdUploadPromotedProductRow.scope_status == "included_product",
            )
            .group_by(AdUploadFile.report_date)
            .order_by(AdUploadFile.report_date)
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
                func.sum(sales_amount_expr(country)).label("sales_amount"),
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
            .order_by(func.sum(sales_amount_expr(country)).desc())
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
                AdUploadFile.report_date,
                func.sum(AdUploadPromotedProductRow.impressions).label("impressions"),
                func.sum(AdUploadPromotedProductRow.clicks).label("clicks"),
                func.sum(AdUploadPromotedProductRow.spend).label("ad_spend"),
                func.sum(AdUploadPromotedProductRow.sales_7d).label("ad_sales"),
                func.sum(AdUploadPromotedProductRow.orders_7d).label("ad_orders"),
            )
            .select_from(AdUploadFile)
            .join(
                AdUploadPromotedProductRow,
                AdUploadPromotedProductRow.source_file_id == AdUploadFile.id,
            )
            .where(
                AdUploadFile.project_id == project_id,
                AdUploadFile.report_type == "ad_promoted_product_report",
                AdUploadFile.country == country,
                AdUploadFile.is_current.is_(True),
                AdUploadFile.report_date.is_not(None),
                AdUploadFile.report_date >= start_date,
                AdUploadFile.report_date <= end_date,
                AdUploadPromotedProductRow.scope_status == "included_product",
            )
            .group_by(AdUploadFile.report_date)
            .order_by(AdUploadFile.report_date)
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


# ─── 10 种 ad 报表类型全量聚合 (ad_analysis 模式用) ────────────────────────────
#
# 每种类型聚合: 一个 summary (期间内总 spend/sales/orders/clicks/impressions 等)
#              + 一个 top-N (按 spend 排序的前 N 行明细，AI 可以基于此做细节分析)
#
# 设计原则:
#  - 每种类型都聚 (即使没数据也返回空 dict, AI 知道"这个类型没数据")
#  - top-N 限制在 20 行, 控制 prompt token
#  - summary 数字保留 2 位小数
#
# 这是 ai_insight_aggregator 的扩展, 跟现有的 _aggregate_ad_by_date_sql 不冲突:
#  现有函数按日期聚 promoted_product (返回时间序列)
#  新函数按 10 种类型分别聚 (返回分类聚合, 适合 ad_analysis 模式)


# 聚合类型 → 报表类型 → 表模型 映射
AD_REPORT_TYPE_TO_MODEL: dict[str, Any] = {
    "ad_promoted_product_report": AdUploadPromotedProductRow,
    "ad_campaign_report": AdUploadCampaignRow,
    "ad_search_term_report": AdUploadSearchTermRow,
    "ad_target_report": AdUploadTargetRow,
    "ad_placement_report": AdUploadPlacementRow,
    "ad_budget_report": AdUploadBudgetRow,
    "ad_invalid_traffic_report": AdUploadInvalidTrafficRow,
    "ad_time_trend_report": AdUploadTimeTrendRow,
    "ad_search_term_share_report": AdUploadSearchTermShareRow,
    "ad_purchased_product_report": AdUploadPurchasedProductRow,
}

# 中文标签 (用于 prompt 提示)
AD_REPORT_TYPE_LABELS: dict[str, str] = {
    "ad_promoted_product_report": "商品推广（按 SKU/ASIN 拆）",
    "ad_campaign_report": "广告活动（按 campaign 拆）",
    "ad_search_term_report": "搜索词（找高花费低转化词）",
    "ad_target_report": "投放（按 target 拆，看首位展示份额）",
    "ad_placement_report": "广告位（按 placement 拆）",
    "ad_budget_report": "预算（含建议预算 vs 实际预算）",
    "ad_invalid_traffic_report": "无效流量",
    "ad_time_trend_report": "按时间看效果（CPC/花费时序）",
    "ad_search_term_share_report": "搜索词展示量份额",
    "ad_purchased_product_report": "已购买商品（看 ad SKU 转化）",
}

# 每种类型聚合 SQL 的 group-by 维度 (返回 row 的字段)
# None 表示不 group (整体聚合)
AD_REPORT_TYPE_GROUP_BY: dict[str, str | None] = {
    "ad_promoted_product_report": "ad_sku",   # 按 SKU 拆
    "ad_campaign_report": "campaign_name",   # 按 campaign 拆
    "ad_search_term_report": "search_term",   # 按搜索词拆
    "ad_target_report": "target_text",       # 按投放词拆
    "ad_placement_report": "placement",      # 按广告位拆
    "ad_budget_report": "campaign_name",     # 按 campaign 拆 (含建议预算)
    "ad_invalid_traffic_report": None,       # 整体聚合
    "ad_time_trend_report": None,            # 整体聚合 (本身已是时序)
    "ad_search_term_share_report": "search_term",  # 按搜索词拆
    "ad_purchased_product_report": "ad_sku", # 按 ad SKU 拆
}

# 每种类型的 top-N 上限
TOP_N_PER_TYPE = 20


def _safe_div(numerator: float, denominator: float) -> float:
    """Division returning 0 on zero denominator, rounded to 2 dp."""
    if not denominator:
        return 0.0
    return round(numerator / denominator, 2)


def _summarize_one_ad_type(
    db: Session,
    *,
    report_type: str,
    project_id: int,
    country: str,
    start_date: date,
    end_date: date,
    progress_cb: ProgressCallback | None,
) -> dict[str, Any]:
    """聚合单种 ad 类型的指标 (summary + top-N)。

    返回结构:
      {
        "report_type": "ad_search_term_report",
        "label": "搜索词（找高花费低转化词）",
        "has_data": True/False,
        "summary": {"spend": ..., "sales": ..., "orders": ..., "clicks": ..., "impressions": ...},
        "top": [ {groupby_field: value, "spend": ..., ...}, ... ],  # top TOP_N_PER_TYPE 按 spend 排序
      }
    """
    model = AD_REPORT_TYPE_TO_MODEL.get(report_type)
    if model is None:
        return {"report_type": report_type, "label": AD_REPORT_TYPE_LABELS.get(report_type, report_type), "has_data": False, "summary": {}, "top": []}

    _report(progress_cb, f"data_aggregating_ad_{report_type}", {
        "step_label": AD_REPORT_TYPE_LABELS.get(report_type, report_type),
        "status": "running",
        "message": f"正在聚合 {report_type} ...",
    })

    # Common WHERE clause (project + country + is_current + report_date range)
    base_where = [
        AdUploadFile.project_id == project_id,
        AdUploadFile.report_type == report_type,
        AdUploadFile.country == country,
        AdUploadFile.is_current.is_(True),
        AdUploadFile.report_date.is_not(None),
        AdUploadFile.report_date >= start_date,
        AdUploadFile.report_date <= end_date,
    ]
    # promoted_product 还有 scope_status 过滤 (排除非店内产品)
    if report_type == "ad_promoted_product_report":
        base_where.append(AdUploadPromotedProductRow.scope_status == "included_product")

    # Determine numeric columns the model has (different per type)
    numeric_cols = {
        col.name for col in model.__table__.columns
        if col.name in {"spend", "sales_7d", "orders_7d", "clicks", "impressions", "units_7d", "budget"}
    }
    if not numeric_cols:
        return {"report_type": report_type, "label": AD_REPORT_TYPE_LABELS.get(report_type, report_type), "has_data": False, "summary": {}, "top": []}

    # ----- summary (整体聚合) -----
    summary_selects = []
    for col in numeric_cols:
        summary_selects.append(func.sum(getattr(model, col)).label(col))
    summary_stmt = select(*summary_selects).select_from(model).join(
        AdUploadFile, AdUploadFile.id == model.source_file_id
    ).where(*base_where)
    summary_row = db.execute(summary_stmt).one()

    summary: dict[str, float] = {}
    total_spend = 0.0
    total_sales = 0.0
    total_clicks = 0
    total_impressions = 0
    total_orders = 0
    for col in numeric_cols:
        v = getattr(summary_row, col) or 0
        if col in {"spend", "sales_7d", "budget"}:
            summary[col] = _round_money(Decimal(str(v)))
        elif col in {"orders_7d", "clicks", "impressions", "units_7d"}:
            summary[col] = int(v)
        else:
            summary[col] = v
    total_spend = summary.get("spend", 0)
    total_sales = summary.get("sales_7d", 0)
    total_orders = summary.get("orders_7d", 0)
    total_clicks = summary.get("clicks", 0)
    total_impressions = summary.get("impressions", 0)
    summary["roas"] = _safe_div(total_sales, total_spend)
    summary["acos"] = _safe_div(total_spend, total_sales) * 100  # percentage
    summary["ctr"] = _safe_div(total_clicks, total_impressions) * 100  # percentage
    summary["cpc"] = _safe_div(total_spend, total_clicks)
    summary["conversion_rate"] = _safe_div(total_orders, total_clicks) * 100  # percentage
    has_data = any(v for v in summary.values() if isinstance(v, (int, float)) and v > 0)

    # ----- top-N (按 spend 排序, 取 spend > 0 的) -----
    group_by_col = AD_REPORT_TYPE_GROUP_BY.get(report_type)
    top: list[dict[str, Any]] = []
    if group_by_col:
        group_by_attr = getattr(model, group_by_col, None)
        if group_by_attr is not None:
            # 找到这个 group_by 字段的类型，决定能不能用
            top_selects = [group_by_attr.label("group_value")]
            for col in numeric_cols:
                top_selects.append(func.sum(getattr(model, col)).label(col))
            top_stmt = (
                select(*top_selects)
                .select_from(model)
                .join(AdUploadFile, AdUploadFile.id == model.source_file_id)
                .where(*base_where)
                .group_by(group_by_attr)
                .having(func.sum(getattr(model, "spend")) > 0)
                .order_by(func.sum(getattr(model, "spend")).desc())
                .limit(TOP_N_PER_TYPE)
            )
            top_rows = db.execute(top_stmt).all()
            for r in top_rows:
                row_dict: dict[str, Any] = {group_by_col: r.group_value}
                row_spend = 0.0
                row_sales = 0.0
                row_orders = 0
                row_clicks = 0
                for col in numeric_cols:
                    v = getattr(r, col) or 0
                    if col in {"spend", "sales_7d", "budget"}:
                        row_dict[col] = _round_money(Decimal(str(v)))
                    elif col in {"orders_7d", "clicks", "impressions", "units_7d"}:
                        row_dict[col] = int(v)
                    else:
                        row_dict[col] = v
                row_spend = row_dict.get("spend", 0)
                row_sales = row_dict.get("sales_7d", 0)
                row_orders = row_dict.get("orders_7d", 0)
                row_clicks = row_dict.get("clicks", 0)
                row_dict["roas"] = _safe_div(row_sales, row_spend)
                row_dict["acos_pct"] = _safe_div(row_spend, row_sales) * 100
                row_dict["conversion_rate_pct"] = _safe_div(row_orders, row_clicks) * 100
                top.append(row_dict)

    _report(progress_cb, f"data_aggregating_ad_{report_type}", {
        "step_label": AD_REPORT_TYPE_LABELS.get(report_type, report_type),
        "status": "completed",
        "record_count": len(top),
        "total_amount": total_spend,
        "message": f"{AD_REPORT_TYPE_LABELS.get(report_type, report_type)}: {len(top)} 条 top 行 (按 spend 排序)",
    })

    return {
        "report_type": report_type,
        "label": AD_REPORT_TYPE_LABELS.get(report_type, report_type),
        "has_data": has_data,
        "summary": summary,
        "top": top,
    }


def _aggregate_ad_breakdown_by_type_sql(
    session_factory,
    project_id: int,
    country: str,
    start_date: date,
    end_date: date,
    progress_cb: ProgressCallback | None,
) -> dict[str, dict[str, Any]]:
    """为 ad_analysis 模式聚 10 种 ad 报表类型。

    Returns:
        {report_type: {summary, top, has_data, label}, ...}

    设计说明:
      - 全部 10 种类型都会尝试聚, 没数据返回空 summary + 空 top (has_data=False)
      - 每种类型发一个 progress 事件 (data_aggregating_ad_<type>), 让前端能看到进度
    """
    db = session_factory()
    result: dict[str, dict[str, Any]] = {}
    try:
        for report_type in AD_REPORT_TYPE_TO_MODEL:
            result[report_type] = _summarize_one_ad_type(
                db,
                report_type=report_type,
                project_id=project_id,
                country=country,
                start_date=start_date,
                end_date=end_date,
                progress_cb=progress_cb,
            )
        return result
    finally:
        db.close()
