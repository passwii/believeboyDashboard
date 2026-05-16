from __future__ import annotations

from datetime import date
from decimal import Decimal

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import (
    AnalysisAdProductRow,
    AnalysisBusinessRow,
    AnalysisSourceFile,
    Project,
    ShipmentSchedule,
    ShipmentScheduleItem,
)
from app.services import infra as redis_service
from app.services.daily.aggregation import (
    _MetricBucket,
    _aggregate_buckets,
    _get_or_create_bucket,
    _set_asin_if_blank,
)
from app.services.daily.sales import _load_sales_metrics
from app.services.daily.ad import _load_ad_metrics
from app.services.daily.inventory import _load_inventory_metrics
from app.utils.country import normalize_country
from app.utils.date_utils import date_range, parse_yyyy_mm_dd
from app.utils.math_utils import round_money, safe_ratio


def _get_project_or_404(db: Session, project_id: int) -> Project:
    row = db.get(Project, project_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    return row


IN_TRANSIT_STATUSES = ("draft", "in_transit")


def _load_in_transit_quantities(
    db: Session,
    project_id: int,
    country: str,
) -> dict[str, int]:
    cached = redis_service.get_shipment_in_transit_qty_cache(project_id, country)
    if cached is not None:
        return cached

    stmt = (
        select(
            ShipmentScheduleItem.sku,
            func.coalesce(func.sum(ShipmentScheduleItem.quantity), 0).label("total"),
        )
        .join(
            ShipmentSchedule,
            ShipmentSchedule.id == ShipmentScheduleItem.shipment_schedule_id,
        )
        .where(
            ShipmentSchedule.project_id == project_id,
            ShipmentSchedule.country == country,
            ShipmentSchedule.shipment_status.in_(IN_TRANSIT_STATUSES),
        )
        .group_by(ShipmentScheduleItem.sku)
    )
    rows = db.execute(stmt).all()
    result = {sku.strip(): int(total) for sku, total in rows if sku}

    redis_service.set_shipment_in_transit_qty_cache(project_id, country, result)
    return result


def _build_asin_to_sku_map(
    db: Session,
    project_id: int,
    country: str,
    start_date: date,
    end_date: date,
) -> dict[str, str]:
    stmt = (
        select(
            AnalysisAdProductRow.asin,
            AnalysisAdProductRow.sku,
        )
        .join(
            AnalysisSourceFile,
            AnalysisSourceFile.id == AnalysisAdProductRow.source_file_id,
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
            AnalysisAdProductRow.asin.is_not(None),
            AnalysisAdProductRow.sku.is_not(None),
        )
        .distinct()
    )
    rows = db.execute(stmt).all()
    asin_to_sku: dict[str, str] = {}
    for asin, sku in rows:
        if asin and sku:
            normalized_asin = asin.strip()
            normalized_sku = sku.strip()
            if normalized_asin and normalized_sku and normalized_asin not in asin_to_sku:
                asin_to_sku[normalized_asin] = normalized_sku
    return asin_to_sku


def _load_business_metrics(
    db: Session,
    *,
    detail_buckets: dict[tuple[str, str], _MetricBucket],
    project_id: int,
    country: str,
    start_date: date,
    end_date: date,
    asin_to_sku_map: dict[str, str],
) -> tuple[set[str], str | None]:
    stmt = (
        select(
            AnalysisSourceFile.period_start_date,
            AnalysisSourceFile.period_end_date,
            AnalysisBusinessRow.asin,
            AnalysisBusinessRow.page_views,
            AnalysisBusinessRow.units_ordered,
            AnalysisBusinessRow.sessions,
            AnalysisBusinessRow.ordered_sales_amount,
        )
        .join(
            AnalysisBusinessRow,
            AnalysisBusinessRow.source_file_id == AnalysisSourceFile.id,
        )
        .where(
            AnalysisSourceFile.project_id == project_id,
            AnalysisSourceFile.report_type == "business_report",
            AnalysisSourceFile.country == country,
            AnalysisSourceFile.is_current.is_(True),
            AnalysisSourceFile.period_start_date.is_not(None),
            AnalysisSourceFile.period_start_date == AnalysisSourceFile.period_end_date,
            AnalysisSourceFile.period_start_date >= start_date,
            AnalysisSourceFile.period_start_date <= end_date,
        )
    )
    rows = db.execute(stmt).all()
    dates: set[str] = set()
    latest: date | None = None

    for period_start, period_end, asin, page_views, units_ordered, sessions, sales_amount in rows:
        if asin is None:
            continue
        normalized_asin = asin.strip()
        if not normalized_asin:
            continue

        effective_date = period_start
        if effective_date is None:
            continue

        dates.add(effective_date.isoformat())
        latest = effective_date if latest is None or effective_date > latest else latest

        sku = asin_to_sku_map.get(normalized_asin)
        if sku is None:
            sku = f"ASIN:{normalized_asin}"

        bucket = _get_or_create_bucket(detail_buckets, effective_date, sku)
        bucket.asin = normalized_asin
        bucket.page_views += int(page_views or 0)
        bucket.units_ordered += int(units_ordered or 0)
        bucket.sessions += int(sessions or 0)
        bucket.business_sales_amount += Decimal(sales_amount or 0)

    return dates, latest.isoformat() if latest is not None else None


def _load_latest_available_dates(
    db: Session,
    *,
    project_id: int,
    country: str,
) -> dict[str, str | None]:
    stmt = select(
        AnalysisSourceFile.report_type,
        AnalysisSourceFile.report_date,
        AnalysisSourceFile.period_start_date,
        AnalysisSourceFile.snapshot_at,
    ).where(
        AnalysisSourceFile.project_id == project_id,
        AnalysisSourceFile.country == country,
        AnalysisSourceFile.is_current.is_(True),
        AnalysisSourceFile.report_type.in_(
            ("sales_report", "ad_product_report", "inventory_report", "business_report")
        ),
    )
    rows = db.execute(stmt).all()

    latest_sales_date: date | None = None
    latest_ad_date: date | None = None
    latest_inventory_date: date | None = None
    latest_business_date: date | None = None

    for report_type, report_date, period_start_date, snapshot_at in rows:
        if report_type == "sales_report":
            business_date = report_date
            if business_date is None:
                continue
            latest_sales_date = (
                business_date
                if latest_sales_date is None or business_date > latest_sales_date
                else latest_sales_date
            )
        elif report_type == "ad_product_report":
            business_date = report_date
            if business_date is None:
                continue
            latest_ad_date = (
                business_date
                if latest_ad_date is None or business_date > latest_ad_date
                else latest_ad_date
            )
        elif report_type == "inventory_report":
            business_date = report_date or (
                snapshot_at.date() if snapshot_at is not None else None
            )
            if business_date is None:
                continue
            latest_inventory_date = (
                business_date
                if latest_inventory_date is None
                or business_date > latest_inventory_date
                else latest_inventory_date
            )
        elif report_type == "business_report":
            business_date = period_start_date
            if business_date is None:
                continue
            latest_business_date = (
                business_date
                if latest_business_date is None
                or business_date > latest_business_date
                else latest_business_date
            )

    return {
        "latest_sales_date": latest_sales_date.isoformat()
        if latest_sales_date is not None
        else None,
        "latest_ad_date": latest_ad_date.isoformat()
        if latest_ad_date is not None
        else None,
        "latest_inventory_date": latest_inventory_date.isoformat()
        if latest_inventory_date is not None
        else None,
        "latest_business_date": latest_business_date.isoformat()
        if latest_business_date is not None
        else None,
    }


def build_daily_analysis(
    db: Session,
    *,
    project_id: int,
    country: str,
    start_date: str,
    end_date: str,
    sku: str | None = None,
) -> dict[str, object]:
    normalized_country = normalize_country(country)
    normalized_start = parse_yyyy_mm_dd(start_date, "start_date")
    normalized_end = parse_yyyy_mm_dd(end_date, "end_date")

    cached = redis_service.get_daily_analysis_cache(
        project_id,
        normalized_country,
        normalized_start.isoformat(),
        normalized_end.isoformat(),
    )
    if cached is not None and sku is None:
        return cached

    project = _get_project_or_404(db, project_id)
    if normalized_start > normalized_end:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="start_date cannot be greater than end_date",
        )

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
    asin_to_sku_map = _build_asin_to_sku_map(
        db,
        project_id=project_id,
        country=normalized_country,
        start_date=normalized_start,
        end_date=normalized_end,
    )
    business_dates, latest_business_date = _load_business_metrics(
        db,
        detail_buckets=detail_buckets,
        project_id=project_id,
        country=normalized_country,
        start_date=normalized_start,
        end_date=normalized_end,
        asin_to_sku_map=asin_to_sku_map,
    )
    latest_available_dates = _load_latest_available_dates(
        db,
        project_id=project_id,
        country=normalized_country,
    )

    detail_rows, summary_rows = _aggregate_buckets(detail_buckets, sku_filter=sku)

    in_transit_map = _load_in_transit_quantities(db, project_id, normalized_country)
    for row in detail_rows:
        row["in_transit_qty"] = in_transit_map.get(row["sku"], 0)

    requested_dates = [
        item.isoformat() for item in date_range(normalized_start, normalized_end)
    ]
    missing_dates = [
        day_text
        for day_text in requested_dates
        if day_text not in sales_dates
        or day_text not in ad_dates
        or day_text not in inventory_dates
        or day_text not in business_dates
    ]

    result = {
        "console": {
            "project_id": int(project.id),
            "project_name": project.project_name,
            "country": normalized_country,
            "start_date": normalized_start.isoformat(),
            "end_date": normalized_end.isoformat(),
            "requested_days": len(requested_dates),
            "summary_days": len(summary_rows),
            "detail_rows": len(detail_rows),
            "sales_source_days": len(sales_dates),
            "ad_source_days": len(ad_dates),
            "inventory_source_days": len(inventory_dates),
            "business_source_days": len(business_dates),
            "missing_dates": missing_dates,
            "latest_sales_date": latest_available_dates["latest_sales_date"]
            or latest_sales_date,
            "latest_ad_date": latest_available_dates["latest_ad_date"]
            or latest_ad_date,
            "latest_inventory_date": latest_available_dates["latest_inventory_date"]
            or latest_inventory_date,
            "latest_business_date": latest_available_dates["latest_business_date"]
            or latest_business_date,
        },
        "summary_rows": summary_rows,
        "detail_rows": detail_rows,
        "available_dates": {
            "sales_report": sorted(sales_dates),
            "ad_product_report": sorted(ad_dates),
            "inventory_report": sorted(inventory_dates),
            "business_report": sorted(business_dates),
        },
    }

    if sku is None:
        redis_service.set_daily_analysis_cache(
            project_id,
            normalized_country,
            normalized_start.isoformat(),
            normalized_end.isoformat(),
            result,
        )
    return result


def build_daily_analysis_all_projects(
    db: Session,
    *,
    project_ids: list[int],
    country: str,
    start_date: str,
    end_date: str,
    sku: str | None = None,
) -> dict[str, object]:
    normalized_country = normalize_country(country)
    normalized_start = parse_yyyy_mm_dd(start_date, "start_date")
    normalized_end = parse_yyyy_mm_dd(end_date, "end_date")

    if normalized_start > normalized_end:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="start_date cannot be greater than end_date",
        )

    project_breakdown: dict[int, dict[str, object]] = {}
    global_buckets: dict[tuple[str, str], _MetricBucket] = {}
    # Collect in_transit quantities from all projects for global aggregation
    global_in_transit_map: dict[str, int] = {}

    # When aggregating across all projects, SKU filtering is not applied
    # because a single SKU belongs to one project and filtering by it
    # would hide data from all other projects.
    all_projects_sku_filter: str | None = None

    for project_id in project_ids:
        project = _get_project_or_404(db, project_id)
        detail_buckets: dict[tuple[str, str], _MetricBucket] = {}

        _load_sales_metrics(
            db,
            detail_buckets=detail_buckets,
            project_id=project_id,
            country=normalized_country,
            start_date=normalized_start,
            end_date=normalized_end,
        )
        _load_ad_metrics(
            db,
            detail_buckets=detail_buckets,
            project_id=project_id,
            country=normalized_country,
            start_date=normalized_start,
            end_date=normalized_end,
        )
        _load_inventory_metrics(
            db,
            detail_buckets=detail_buckets,
            project_id=project_id,
            country=normalized_country,
            start_date=normalized_start,
            end_date=normalized_end,
        )
        asin_to_sku_map = _build_asin_to_sku_map(
            db,
            project_id=project_id,
            country=normalized_country,
            start_date=normalized_start,
            end_date=normalized_end,
        )
        _load_business_metrics(
            db,
            detail_buckets=detail_buckets,
            project_id=project_id,
            country=normalized_country,
            start_date=normalized_start,
            end_date=normalized_end,
            asin_to_sku_map=asin_to_sku_map,
        )

        project_detail, project_summary = _aggregate_buckets(
            detail_buckets, sku_filter=all_projects_sku_filter,
        )
        project_breakdown[project_id] = {
            "project_name": project.project_name,
            "summary_rows": project_summary,
            "detail_rows": project_detail,
        }

        for key, bucket in detail_buckets.items():
            global_bucket = global_buckets.setdefault(key, _MetricBucket())
            _set_asin_if_blank(global_bucket, bucket.asin)
            global_bucket.order_qty += bucket.order_qty
            global_bucket.sales_amount += bucket.sales_amount
            global_bucket.impressions += bucket.impressions
            global_bucket.clicks += bucket.clicks
            global_bucket.ad_spend += bucket.ad_spend
            global_bucket.ad_orders += bucket.ad_orders
            global_bucket.available_qty += bucket.available_qty
            global_bucket.page_views += bucket.page_views
            global_bucket.units_ordered += bucket.units_ordered
            global_bucket.sessions += bucket.sessions
            global_bucket.business_sales_amount += bucket.business_sales_amount

        project_in_transit_map = _load_in_transit_quantities(
            db, project_id, normalized_country
        )
        for row in project_detail:
            row["in_transit_qty"] = project_in_transit_map.get(row["sku"], 0)

        # Aggregate into global in_transit map
        for sku, qty in project_in_transit_map.items():
            global_in_transit_map[sku] = global_in_transit_map.get(sku, 0) + qty

    global_detail, global_summary = _aggregate_buckets(global_buckets, sku_filter=all_projects_sku_filter)

    # Inject in_transit_qty for global detail rows
    for row in global_detail:
        row["in_transit_qty"] = global_in_transit_map.get(row["sku"], 0)

    available_dates: dict[str, list[str]] = {
        "sales_report": [],
        "ad_product_report": [],
        "inventory_report": [],
        "business_report": [],
    }
    report_type_key_map = {
        "latest_sales_date": "sales_report",
        "latest_ad_date": "ad_product_report",
        "latest_inventory_date": "inventory_report",
        "latest_business_date": "business_report",
    }
    for project_id in project_ids:
        proj_dates = _load_latest_available_dates(
            db, project_id=project_id, country=normalized_country
        )
        for key, latest_date in proj_dates.items():
            if latest_date is not None:
                report_type = report_type_key_map.get(key)
                if report_type is None:
                    continue
                current = available_dates[report_type]
                if not current or latest_date > current[0]:
                    available_dates[report_type] = [latest_date]
    requested_dates = [
        item.isoformat() for item in date_range(normalized_start, normalized_end)
    ]

    return {
        "summary_rows": global_summary,
        "detail_rows": global_detail,
        "available_dates": available_dates,
        "project_breakdown": project_breakdown,
    }
