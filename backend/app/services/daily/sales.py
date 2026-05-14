from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AnalysisSalesOrderRow, AnalysisSourceFile
from app.services.daily.aggregation import _get_or_create_bucket, _set_asin_if_blank


def _load_sales_metrics(
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
            AnalysisSalesOrderRow.sku,
            AnalysisSalesOrderRow.asin,
            AnalysisSalesOrderRow.quantity,
            AnalysisSalesOrderRow.item_price,
            AnalysisSalesOrderRow.shipping_price,
        )
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
    )
    rows = db.execute(stmt).all()
    dates: set[str] = set()
    latest: date | None = None
    for report_date, sku, asin, quantity, item_price, shipping_price in rows:
        if report_date is None:
            continue
        normalized_sku = (sku or "").strip()
        if not normalized_sku:
            continue
        dates.add(report_date.isoformat())
        latest = report_date if latest is None or report_date > latest else latest
        bucket = _get_or_create_bucket(detail_buckets, report_date, normalized_sku)
        _set_asin_if_blank(bucket, asin)
        bucket.order_qty += int(quantity or 0)
        bucket.sales_amount += Decimal(item_price or 0) + Decimal(shipping_price or 0)
    return dates, latest.isoformat() if latest is not None else None
