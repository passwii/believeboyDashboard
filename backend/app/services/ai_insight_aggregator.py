from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal, ROUND_HALF_UP
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
        }


# Sub-status values reported during aggregation
AGGREGATE_STEP_SALES = "data_aggregating_sales"
AGGREGATE_STEP_AD = "data_aggregating_ad"
AGGREGATE_STEP_INVENTORY = "data_aggregating_inventory"
AGGREGATE_STEP_COMPARISON_SALES = "data_aggregating_comparison_sales"
AGGREGATE_STEP_COMPARISON_AD = "data_aggregating_comparison_ad"
AGGREGATE_STEP_TOP_SKUS = "data_aggregating_top_skus"
AGGREGATE_STEP_AD_CAMPAIGNS = "data_aggregating_ad_campaigns"


ProgressCallback = Callable[[str], None]


def _round_money(value: Decimal) -> float:
    return float(value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def _safe_ratio(numerator: Decimal, denominator: int) -> float:
    if denominator <= 0:
        return 0.0
    return float(Decimal(str(numerator)) / Decimal(str(denominator)))


def _daterange(start_date: date, end_date: date) -> list[date]:
    days = (end_date - start_date).days
    return [start_date + timedelta(days=offset) for offset in range(days + 1)]


def _get_project_or_404(db: Session, project_id: int) -> Project | None:
    row = db.get(Project, project_id)
    return row


def _report(progress_cb: ProgressCallback | None, step: str) -> None:
    if progress_cb:
        progress_cb(step)


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

    # Run all queries in parallel using a thread pool
    # Each function receives its own DB session so they can run concurrently
    from app.db.session import SessionLocal

    def run_queries():
        session_factory = SessionLocal

        with ThreadPoolExecutor(max_workers=6) as executor:
            f_sales = executor.submit(
                _aggregate_sales_by_date_sql,
                session_factory,
                project_id,
                country,
                start_date,
                end_date,
                AGGREGATE_STEP_SALES,
                progress_cb,
            )
            f_ad = executor.submit(
                _aggregate_ad_by_date_sql,
                session_factory,
                project_id,
                country,
                start_date,
                end_date,
                AGGREGATE_STEP_AD,
                progress_cb,
            )
            f_inventory = executor.submit(
                _aggregate_inventory_summary,
                session_factory,
                project_id,
                country,
                end_date,
                AGGREGATE_STEP_INVENTORY,
                progress_cb,
            )
            f_comp_sales = executor.submit(
                _aggregate_sales_by_date_sql,
                session_factory,
                project_id,
                country,
                comp_start,
                comp_end,
                AGGREGATE_STEP_COMPARISON_SALES,
                progress_cb,
            )
            f_comp_ad = executor.submit(
                _aggregate_ad_by_date_sql,
                session_factory,
                project_id,
                country,
                comp_start,
                comp_end,
                AGGREGATE_STEP_COMPARISON_AD,
                progress_cb,
            )
            f_top_skus = executor.submit(
                _get_top_skus_sql,
                session_factory,
                project_id,
                country,
                start_date,
                end_date,
                AGGREGATE_STEP_TOP_SKUS,
                progress_cb,
            )

            # Wait for first 4 before starting ad campaigns (they're independent)
            sales_by_date, sales_coverage = f_sales.result()
            ad_by_date, ad_coverage = f_ad.result()
            inventory_summary = f_inventory.result()
            comp_sales_result, _ = f_comp_sales.result()
            comp_ad_result, _ = f_comp_ad.result()
            top_skus = f_top_skus.result()

            # Ad campaigns (can start after ad_by_date is done, but independently)
            ad_campaigns = _get_ad_campaign_summary_sql(
                session_factory,
                project_id,
                country,
                start_date,
                end_date,
                AGGREGATE_STEP_AD_CAMPAIGNS,
                progress_cb,
            )

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
        )

    return run_queries()


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
        _report(progress_cb, step)
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

        return result, {"days": len(set(r["date"] for r in result))}
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
        _report(progress_cb, step)
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

        return result, {"days": len(set(r["date"] for r in result))}
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
        _report(progress_cb, step)
        end_dt = datetime.combine(as_of_date, datetime.max.time(), tzinfo=UTC)

        stmt = (
            select(AnalysisSourceFile)
            .where(
                AnalysisSourceFile.project_id == project_id,
                AnalysisSourceFile.report_type == "inventory_report",
                AnalysisSourceFile.country == country,
                AnalysisSourceFile.is_current.is_(True),
                (
                    (AnalysisSourceFile.report_date.is_not(None))
                    & (AnalysisSourceFile.report_date <= as_of_date)
                )
                | (
                    AnalysisSourceFile.report_date.is_(None)
                    & AnalysisSourceFile.snapshot_at.is_not(None)
                    & (AnalysisSourceFile.snapshot_at <= end_dt)
                ),
            )
            .order_by(
                AnalysisSourceFile.report_date.desc(),
                AnalysisSourceFile.snapshot_at.desc(),
                AnalysisSourceFile.version.desc(),
                AnalysisSourceFile.id.desc(),
            )
            .limit(1)
        )
        source = db.execute(stmt).scalar_one_or_none()

        if source is None:
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

        return {
            "available": int(agg.total_available or 0),
            "out_of_stock_skus": out_of_stock,
            "out_of_stock_count": int(agg.out_of_stock_count or 0),
            "aging_summary": aging_total,
            "snapshot_date": (
                source.report_date.isoformat()
                if source.report_date
                else source.snapshot_at.isoformat()
                if source.snapshot_at
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
        _report(progress_cb, step)
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

        return [
            {
                "sku": (sku or "").strip(),
                "asin": asin,
                "order_qty": int(order_qty or 0),
                "sales_amount": _round_money(Decimal(str(sales_amount or 0))),
            }
            for sku, asin, order_qty, sales_amount in rows
        ]
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
        _report(progress_cb, step)
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

        return [
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
    finally:
        db.close()
