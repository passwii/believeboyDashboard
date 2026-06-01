from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AdUploadFile, AdUploadPromotedProductRow
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
            AdUploadFile.report_date,
            AdUploadPromotedProductRow.ad_sku,
            AdUploadPromotedProductRow.ad_asin,
            AdUploadPromotedProductRow.impressions,
            AdUploadPromotedProductRow.clicks,
            AdUploadPromotedProductRow.spend,
            AdUploadPromotedProductRow.orders_7d,
        )
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
            # NOTE: scope_status 过滤暂时拿掉 (Step 7 Alembic 给 C 表加列后再加回)
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
