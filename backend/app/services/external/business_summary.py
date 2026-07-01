"""Business Summary service for the external API.

Aggregates AnalysisBusinessRow by ASIN and joins with ShopCalculation
for cost/profit/breakeven data.
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import List, Optional, Sequence

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.models import AnalysisBusinessRow, AnalysisSourceFile, ShopCalculation
from app.schemas.external.business_summary import BusinessSummaryAggregateRow
from app.utils.math_utils import round_money, round_ratio, safe_ratio


def _select_business_file_ids(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: date,
    date_to: date,
) -> List[int]:
    """Select latest version business report file IDs for the project/country/date range."""
    latest_versions = (
        select(
            AnalysisSourceFile.project_id.label("project_id"),
            AnalysisSourceFile.report_type.label("report_type"),
            AnalysisSourceFile.country.label("country"),
            AnalysisSourceFile.report_date.label("report_date"),
            func.max(AnalysisSourceFile.version).label("max_version"),
        )
        .where(
            AnalysisSourceFile.project_id == project_id,
            AnalysisSourceFile.country == country,
            AnalysisSourceFile.report_type == "business_report",
            AnalysisSourceFile.is_current.is_(True),
            AnalysisSourceFile.ingestion_status == "success",
            AnalysisSourceFile.recognition_status == "recognized",
            or_(
                AnalysisSourceFile.report_date.between(date_from, date_to),
                and_(
                    AnalysisSourceFile.report_date.is_(None),
                    AnalysisSourceFile.period_start_date <= date_to,
                    AnalysisSourceFile.period_end_date >= date_from,
                ),
            ),
        )
        .group_by(
            AnalysisSourceFile.project_id,
            AnalysisSourceFile.report_type,
            AnalysisSourceFile.country,
            AnalysisSourceFile.report_date,
        )
        .subquery()
    )

    stmt = (
        select(AnalysisSourceFile.id)
        .join(
            latest_versions,
            and_(
                AnalysisSourceFile.project_id == latest_versions.c.project_id,
                AnalysisSourceFile.report_type == latest_versions.c.report_type,
                AnalysisSourceFile.country == latest_versions.c.country,
                AnalysisSourceFile.report_date == latest_versions.c.report_date,
                AnalysisSourceFile.version == latest_versions.c.max_version,
            ),
        )
    )

    return list(db.execute(stmt).scalars().all())


def _get_shop_calculation_map(
    db: Session,
    *,
    project_id: int,
    country: str,
    asins: Sequence[str],
) -> dict[str, ShopCalculation]:
    """Fetch latest ShopCalculation per ASIN for the project/country."""
    if not asins:
        return {}

    stmt = (
        select(ShopCalculation)
        .where(
            ShopCalculation.project_id == project_id,
            ShopCalculation.country == country,
            ShopCalculation.asin.in_(asins),
        )
        .order_by(ShopCalculation.asin, ShopCalculation.updated_at.desc())
    )

    rows = db.execute(stmt).scalars().all()
    result = {}
    for row in rows:
        if row.asin not in result:
            result[row.asin] = row
    return result


def aggregate_business_summary(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: date,
    date_to: date,
) -> List[BusinessSummaryAggregateRow]:
    """Aggregate business report by ASIN and enrich with ShopCalculation data."""
    file_ids = _select_business_file_ids(
        db, project_id=project_id, country=country, date_from=date_from, date_to=date_to
    )
    if not file_ids:
        return []

    # Aggregate business rows by ASIN
    stmt = (
        select(
            AnalysisBusinessRow.asin,
            func.coalesce(func.sum(AnalysisBusinessRow.page_views), 0).label("page_views"),
            func.coalesce(func.sum(AnalysisBusinessRow.sessions), 0).label("sessions"),
            func.coalesce(func.sum(AnalysisBusinessRow.units_ordered), 0).label("units_ordered"),
            func.coalesce(func.sum(AnalysisBusinessRow.ordered_sales_amount), 0).label("ordered_sales_amount"),
        )
        .where(
            AnalysisBusinessRow.source_file_id.in_(file_ids),
            AnalysisBusinessRow.asin.isnot(None),
            AnalysisBusinessRow.asin != "",
        )
        .group_by(AnalysisBusinessRow.asin)
    )

    agg_rows = db.execute(stmt).all()

    # Collect ASINs for ShopCalculation lookup
    asins = [r.asin for r in agg_rows if r.asin]
    shop_map = _get_shop_calculation_map(db, project_id=project_id, country=country, asins=asins)

    # Build response rows
    result: List[BusinessSummaryAggregateRow] = []
    for r in agg_rows:
        asin = r.asin
        pv = int(r.page_views or 0)
        sessions = int(r.sessions or 0)
        units = int(r.units_ordered or 0)
        sales = Decimal(str(r.ordered_sales_amount or 0))

        cvr = round_ratio(safe_ratio(Decimal(units), Decimal(sessions))) if sessions else 0.0

        shop = shop_map.get(asin)
        if shop:
            cost_total = round_money(
                (shop.fob_product_cost_rmb + shop.first_leg_cost_rmb) / shop.usd_to_rmb_rate
                if shop.usd_to_rmb_rate
                else Decimal("0")
            )
            profit = round_money(shop.profit_usd)
            profit_rate = round_ratio(shop.profit_rate * 100)  # convert to percent
            breakeven_units = int(
                safe_ratio(
                    (shop.fob_product_cost_rmb + shop.first_leg_cost_rmb) / shop.usd_to_rmb_rate,
                    shop.sale_price_usd - shop.referral_fee_usd - shop.fba_fulfillment_fee_usd
                    - shop.advertising_fee_usd - shop.return_loss_usd - shop.inbound_config_fee_usd
                    - shop.storage_fee_usd,
                )
            ) if shop.sale_price_usd else 0
        else:
            cost_total = 0.0
            profit = 0.0
            profit_rate = 0.0
            breakeven_units = 0

        result.append(
            BusinessSummaryAggregateRow(
                asin=asin,
                page_views=pv,
                sessions=sessions,
                units_ordered=units,
                ordered_sales_amount=round_money(sales),
                cvr=cvr,
                cost_total=cost_total,
                profit=profit,
                profit_rate=profit_rate,
                breakeven_units=breakeven_units,
            )
        )

    return result


def build_business_summary(rows: List[BusinessSummaryAggregateRow]) -> dict:
    """Build summary totals for business summary."""
    total_pv = sum(r.page_views for r in rows)
    total_sessions = sum(r.sessions for r in rows)
    total_units = sum(r.units_ordered for r in rows)
    total_sales = sum(Decimal(str(r.ordered_sales_amount or 0)) for r in rows)
    total_cost = sum(Decimal(str(r.cost_total or 0)) for r in rows)
    total_profit = sum(Decimal(str(r.profit or 0)) for r in rows)

    return {
        "total_asins": len(rows),
        "total_page_views": total_pv,
        "total_sessions": total_sessions,
        "total_units_ordered": total_units,
        "total_sales_amount": round_money(total_sales),
        "total_cost": round_money(total_cost),
        "total_profit": round_money(total_profit),
        "overall_cvr": round_ratio(safe_ratio(Decimal(total_units), Decimal(total_sessions))) if total_sessions else 0.0,
        "overall_profit_rate": round_ratio(safe_ratio(total_profit, total_sales) * 100) if total_sales else 0.0,
    }