from __future__ import annotations

from datetime import UTC, date, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AnalysisSourceFile, InventorySnapshotRow
from app.services.daily.aggregation import _get_or_create_bucket, _set_asin_if_blank


def _load_inventory_metrics(
    db: Session,
    *,
    detail_buckets: dict[tuple[str, str], object],
    project_id: int,
    country: str,
    start_date: date,
    end_date: date,
) -> tuple[set[str], str | None]:
    start_dt = datetime.combine(start_date, datetime.min.time(), tzinfo=UTC)
    end_dt = datetime.combine(end_date, datetime.max.time(), tzinfo=UTC)
    stmt = (
        select(AnalysisSourceFile)
        .where(
            AnalysisSourceFile.project_id == project_id,
            AnalysisSourceFile.report_type == "inventory_report",
            AnalysisSourceFile.country == country,
            (
                (AnalysisSourceFile.report_date.is_not(None))
                & (AnalysisSourceFile.report_date >= start_date)
                & (AnalysisSourceFile.report_date <= end_date)
            )
            | (
                AnalysisSourceFile.report_date.is_(None)
                & AnalysisSourceFile.snapshot_at.is_not(None)
                & (AnalysisSourceFile.snapshot_at >= start_dt)
                & (AnalysisSourceFile.snapshot_at <= end_dt)
            ),
        )
        .order_by(
            AnalysisSourceFile.report_date.desc(),
            AnalysisSourceFile.snapshot_at.desc(),
            AnalysisSourceFile.version.desc(),
            AnalysisSourceFile.id.desc(),
        )
    )
    sources = db.execute(stmt).scalars().all()
    latest_source_by_date: dict[date, AnalysisSourceFile] = {}
    for source in sources:
        business_date = source.report_date or (
            source.snapshot_at.date() if source.snapshot_at is not None else None
        )
        if business_date is None:
            continue
        if business_date not in latest_source_by_date:
            latest_source_by_date[business_date] = source

    if not latest_source_by_date:
        return set(), None

    source_id_to_date = {
        int(source.id): business_date
        for business_date, source in latest_source_by_date.items()
    }
    latest_date = max(source_id_to_date.values())
    row_stmt = select(
        InventorySnapshotRow.source_file_id,
        InventorySnapshotRow.sku,
        InventorySnapshotRow.asin,
        InventorySnapshotRow.available_qty,
    ).where(InventorySnapshotRow.source_file_id.in_(source_id_to_date.keys()))
    rows = db.execute(row_stmt).all()
    dates = {snapshot_date.isoformat() for snapshot_date in source_id_to_date.values()}
    for source_file_id, sku, asin, available_qty in rows:
        snapshot_date = source_id_to_date.get(int(source_file_id))
        if snapshot_date is None:
            continue
        normalized_sku = (sku or "").strip()
        if not normalized_sku:
            continue
        bucket = _get_or_create_bucket(detail_buckets, snapshot_date, normalized_sku)
        _set_asin_if_blank(bucket, asin)
        bucket.available_qty += int(available_qty or 0)
    return dates, latest_date.isoformat()
