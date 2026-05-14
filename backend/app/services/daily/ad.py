from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AnalysisAdProductRow, AnalysisSourceFile
from app.services.daily.aggregation import _get_or_create_bucket, _set_asin_if_blank


def _load_ad_metrics(
    db: Session,
    *,
    detail_buckets: dict[tuple[str, str], object],
    project_id: int,
    country: str,
    start_date: date,
    end_date: date,
) -> tuple[set[str], str | None]:
    stmt = (
        select(
            AnalysisSourceFile.report_date,
            AnalysisAdProductRow.sku,
            AnalysisAdProductRow.asin,
            AnalysisAdProductRow.impressions,
            AnalysisAdProductRow.clicks,
            AnalysisAdProductRow.spend,
            AnalysisAdProductRow.orders_7d,
        )
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
    )
    rows = db.execute(stmt).all()
    dates: set[str] = set()
    latest: date | None = None
    for report_date, sku, asin, impressions, clicks, spend, orders_7d in rows:
        if report_date is None:
            continue
        normalized_sku = (sku or "").strip()
        if not normalized_sku:
            continue
        dates.add(report_date.isoformat())
        latest = report_date if latest is None or report_date > latest else latest
        bucket = _get_or_create_bucket(detail_buckets, report_date, normalized_sku)
        _set_asin_if_blank(bucket, asin)
        bucket.impressions += int(impressions or 0)
        bucket.clicks += int(clicks or 0)
        bucket.ad_spend += Decimal(spend or 0)
        bucket.ad_orders += int(orders_7d or 0)
    return dates, latest.isoformat() if latest is not None else None
