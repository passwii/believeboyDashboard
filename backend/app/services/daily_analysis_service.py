from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal, ROUND_HALF_UP

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AnalysisAdProductRow, AnalysisSalesOrderRow, AnalysisSourceFile, InventorySnapshotRow, Project

COUNTRY_ALIASES = {
    'US': 'US',
    'USA': 'US',
    '美国': 'US',
    '美国站': 'US',
    'DE': 'DE',
    'GERMANY': 'DE',
    '德国': 'DE',
    '德国站': 'DE',
    'UK': 'UK',
    'GB': 'UK',
    'UNITED KINGDOM': 'UK',
    '英国': 'UK',
    '英国站': 'UK',
}
ALLOWED_COUNTRIES = {'US', 'DE', 'UK'}


@dataclass
class _MetricBucket:
    asin: str | None = None
    order_qty: int = 0
    sales_amount: Decimal = Decimal('0')
    impressions: int = 0
    clicks: int = 0
    ad_spend: Decimal = Decimal('0')
    ad_orders: int = 0
    available_qty: int = 0


def _normalize_country(value: str | None) -> str:
    normalized = (value or '').strip().upper()
    if not normalized:
        return 'US'
    mapped = COUNTRY_ALIASES.get(normalized, normalized)
    if mapped not in ALLOWED_COUNTRIES:
        allowed = ', '.join(sorted(ALLOWED_COUNTRIES))
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f'country must be one of: {allowed}')
    return mapped


def _parse_date(value: str | None, field_name: str) -> date:
    text = (value or '').strip()
    if not text:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f'{field_name} is required')
    try:
        return date.fromisoformat(text)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f'{field_name} must be YYYY-MM-DD') from exc


def _round_money(value: Decimal) -> float:
    return float(value.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP))


def _safe_ratio(numerator: Decimal, denominator: int) -> float:
    if denominator <= 0:
        return 0.0
    return _round_money(numerator / Decimal(denominator))


def _daterange(start_date: date, end_date: date) -> list[date]:
    days = (end_date - start_date).days
    return [start_date + timedelta(days=offset) for offset in range(days + 1)]


def _bucket_key(target_date: date, sku: str) -> tuple[str, str]:
    return target_date.isoformat(), sku


def _get_or_create_bucket(buckets: dict[tuple[str, str], _MetricBucket], target_date: date, sku: str) -> _MetricBucket:
    return buckets.setdefault(_bucket_key(target_date, sku), _MetricBucket())


def _set_asin_if_blank(bucket: _MetricBucket, asin: str | None) -> None:
    normalized = (asin or '').strip() or None
    if bucket.asin is None and normalized is not None:
        bucket.asin = normalized


def _get_project_or_404(db: Session, project_id: int) -> Project:
    row = db.get(Project, project_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail='项目不存在')
    return row


def build_daily_analysis(
    db: Session,
    *,
    project_id: int,
    country: str,
    start_date: str,
    end_date: str,
) -> dict[str, object]:
    project = _get_project_or_404(db, project_id)
    normalized_country = _normalize_country(country)
    normalized_start = _parse_date(start_date, 'start_date')
    normalized_end = _parse_date(end_date, 'end_date')
    if normalized_start > normalized_end:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail='start_date cannot be greater than end_date')

    detail_buckets: dict[tuple[str, str], _MetricBucket] = {}
    sales_dates, latest_sales_date = _load_sales_metrics(
        db,
        detail_buckets=detail_buckets,
        project_id=project_id,
        country=normalized_country,
        start_date=normalized_start,
        end_date=normalized_end,
    )
    ad_dates, latest_ad_date = _load_ad_metrics(
        db,
        detail_buckets=detail_buckets,
        project_id=project_id,
        country=normalized_country,
        start_date=normalized_start,
        end_date=normalized_end,
    )
    inventory_dates, latest_inventory_date = _load_inventory_metrics(
        db,
        detail_buckets=detail_buckets,
        project_id=project_id,
        country=normalized_country,
        start_date=normalized_start,
        end_date=normalized_end,
    )
    latest_available_dates = _load_latest_available_dates(
        db,
        project_id=project_id,
        country=normalized_country,
    )

    detail_rows: list[dict[str, object]] = []
    summary_map: dict[str, dict[str, object]] = {}
    for (day_text, sku), bucket in sorted(detail_buckets.items(), key=lambda item: (item[0][0], item[0][1])):
        detail_row = {
            'date': day_text,
            'sku': sku,
            'asin': bucket.asin,
            'order_qty': int(bucket.order_qty),
            'sales_amount': _round_money(bucket.sales_amount),
            'impressions': int(bucket.impressions),
            'clicks': int(bucket.clicks),
            'cpc': _safe_ratio(bucket.ad_spend, bucket.clicks),
            'ad_spend': _round_money(bucket.ad_spend),
            'ad_orders': int(bucket.ad_orders),
            'available_qty': int(bucket.available_qty),
        }
        detail_rows.append(detail_row)

        summary = summary_map.setdefault(
            day_text,
            {
                'date': day_text,
                'order_qty': 0,
                'sales_amount': Decimal('0'),
                'impressions': 0,
                'clicks': 0,
                'ad_spend': Decimal('0'),
                'ad_orders': 0,
                'available_qty': 0,
            },
        )
        summary['order_qty'] = int(summary['order_qty']) + int(bucket.order_qty)
        summary['sales_amount'] = Decimal(summary['sales_amount']) + bucket.sales_amount
        summary['impressions'] = int(summary['impressions']) + int(bucket.impressions)
        summary['clicks'] = int(summary['clicks']) + int(bucket.clicks)
        summary['ad_spend'] = Decimal(summary['ad_spend']) + bucket.ad_spend
        summary['ad_orders'] = int(summary['ad_orders']) + int(bucket.ad_orders)
        summary['available_qty'] = int(summary['available_qty']) + int(bucket.available_qty)

    summary_rows = [
        {
            'date': item['date'],
            'order_qty': int(item['order_qty']),
            'sales_amount': _round_money(Decimal(item['sales_amount'])),
            'impressions': int(item['impressions']),
            'clicks': int(item['clicks']),
            'cpc': _safe_ratio(Decimal(item['ad_spend']), int(item['clicks'])),
            'ad_spend': _round_money(Decimal(item['ad_spend'])),
            'ad_orders': int(item['ad_orders']),
            'available_qty': int(item['available_qty']),
        }
        for item in sorted(summary_map.values(), key=lambda row: str(row['date']))
    ]

    requested_dates = [item.isoformat() for item in _daterange(normalized_start, normalized_end)]
    missing_dates = [
        day_text
        for day_text in requested_dates
        if day_text not in sales_dates or day_text not in ad_dates or day_text not in inventory_dates
    ]

    return {
        'console': {
            'project_id': int(project.id),
            'project_name': project.project_name,
            'country': normalized_country,
            'start_date': normalized_start.isoformat(),
            'end_date': normalized_end.isoformat(),
            'requested_days': len(requested_dates),
            'summary_days': len(summary_rows),
            'detail_rows': len(detail_rows),
            'sales_source_days': len(sales_dates),
            'ad_source_days': len(ad_dates),
            'inventory_source_days': len(inventory_dates),
            'missing_dates': missing_dates,
            'latest_sales_date': latest_available_dates['latest_sales_date'] or latest_sales_date,
            'latest_ad_date': latest_available_dates['latest_ad_date'] or latest_ad_date,
            'latest_inventory_date': latest_available_dates['latest_inventory_date'] or latest_inventory_date,
        },
        'summary_rows': summary_rows,
        'detail_rows': detail_rows,
        'available_dates': {
            'sales_report': sorted(sales_dates),
            'ad_product_report': sorted(ad_dates),
            'inventory_report': sorted(inventory_dates),
        },
    }


def _load_sales_metrics(
    db: Session,
    *,
    detail_buckets: dict[tuple[str, str], _MetricBucket],
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
        )
        .join(AnalysisSalesOrderRow, AnalysisSalesOrderRow.source_file_id == AnalysisSourceFile.id)
        .where(
            AnalysisSourceFile.project_id == project_id,
            AnalysisSourceFile.report_type == 'sales_report',
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
    for report_date, sku, asin, quantity, item_price in rows:
        if report_date is None:
            continue
        normalized_sku = (sku or '').strip()
        if not normalized_sku:
            continue
        dates.add(report_date.isoformat())
        latest = report_date if latest is None or report_date > latest else latest
        bucket = _get_or_create_bucket(detail_buckets, report_date, normalized_sku)
        _set_asin_if_blank(bucket, asin)
        bucket.order_qty += int(quantity or 0)
        bucket.sales_amount += Decimal(item_price or 0)
    return dates, latest.isoformat() if latest is not None else None


def _load_ad_metrics(
    db: Session,
    *,
    detail_buckets: dict[tuple[str, str], _MetricBucket],
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
        .join(AnalysisAdProductRow, AnalysisAdProductRow.source_file_id == AnalysisSourceFile.id)
        .where(
            AnalysisSourceFile.project_id == project_id,
            AnalysisSourceFile.report_type == 'ad_product_report',
            AnalysisSourceFile.country == country,
            AnalysisSourceFile.is_current.is_(True),
            AnalysisSourceFile.report_date.is_not(None),
            AnalysisSourceFile.report_date >= start_date,
            AnalysisSourceFile.report_date <= end_date,
            AnalysisAdProductRow.scope_status == 'included_product',
        )
    )
    rows = db.execute(stmt).all()
    dates: set[str] = set()
    latest: date | None = None
    for report_date, sku, asin, impressions, clicks, spend, orders_7d in rows:
        if report_date is None:
            continue
        normalized_sku = (sku or '').strip()
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


def _load_inventory_metrics(
    db: Session,
    *,
    detail_buckets: dict[tuple[str, str], _MetricBucket],
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
            AnalysisSourceFile.report_type == 'inventory_report',
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
        business_date = source.report_date or (source.snapshot_at.date() if source.snapshot_at is not None else None)
        if business_date is None:
            continue
        if business_date not in latest_source_by_date:
            latest_source_by_date[business_date] = source

    if not latest_source_by_date:
        return set(), None

    source_id_to_date = {int(source.id): business_date for business_date, source in latest_source_by_date.items()}
    latest_date = max(source_id_to_date.values())
    row_stmt = (
        select(
            InventorySnapshotRow.source_file_id,
            InventorySnapshotRow.sku,
            InventorySnapshotRow.asin,
            InventorySnapshotRow.available_qty,
        )
        .where(InventorySnapshotRow.source_file_id.in_(source_id_to_date.keys()))
    )
    rows = db.execute(row_stmt).all()
    dates = {snapshot_date.isoformat() for snapshot_date in source_id_to_date.values()}
    for source_file_id, sku, asin, available_qty in rows:
        snapshot_date = source_id_to_date.get(int(source_file_id))
        if snapshot_date is None:
            continue
        normalized_sku = (sku or '').strip()
        if not normalized_sku:
            continue
        bucket = _get_or_create_bucket(detail_buckets, snapshot_date, normalized_sku)
        _set_asin_if_blank(bucket, asin)
        bucket.available_qty += int(available_qty or 0)
    return dates, latest_date.isoformat()


def _load_latest_available_dates(
    db: Session,
    *,
    project_id: int,
    country: str,
) -> dict[str, str | None]:
    stmt = (
        select(
            AnalysisSourceFile.report_type,
            AnalysisSourceFile.report_date,
            AnalysisSourceFile.snapshot_at,
        )
        .where(
            AnalysisSourceFile.project_id == project_id,
            AnalysisSourceFile.country == country,
            AnalysisSourceFile.is_current.is_(True),
            AnalysisSourceFile.report_type.in_(('sales_report', 'ad_product_report', 'inventory_report')),
        )
    )
    rows = db.execute(stmt).all()

    latest_sales_date: date | None = None
    latest_ad_date: date | None = None
    latest_inventory_date: date | None = None

    for report_type, report_date, snapshot_at in rows:
        if report_type == 'sales_report':
            business_date = report_date
            if business_date is None:
                continue
            latest_sales_date = business_date if latest_sales_date is None or business_date > latest_sales_date else latest_sales_date
        elif report_type == 'ad_product_report':
            business_date = report_date
            if business_date is None:
                continue
            latest_ad_date = business_date if latest_ad_date is None or business_date > latest_ad_date else latest_ad_date
        elif report_type == 'inventory_report':
            business_date = report_date or (snapshot_at.date() if snapshot_at is not None else None)
            if business_date is None:
                continue
            latest_inventory_date = (
                business_date
                if latest_inventory_date is None or business_date > latest_inventory_date
                else latest_inventory_date
            )

    return {
        'latest_sales_date': latest_sales_date.isoformat() if latest_sales_date is not None else None,
        'latest_ad_date': latest_ad_date.isoformat() if latest_ad_date is not None else None,
        'latest_inventory_date': latest_inventory_date.isoformat() if latest_inventory_date is not None else None,
    }
