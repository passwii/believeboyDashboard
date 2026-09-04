from __future__ import annotations

from datetime import date
from decimal import Decimal, ROUND_HALF_UP

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import (
    AdUploadFile,
    AdUploadPromotedProductRow,
    AnalysisBusinessRow,
    AnalysisSourceFile,
    Project,
    ShipmentSchedule,
    ShipmentScheduleItem,
)
from app.services import exchange_rate_service
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
            AdUploadPromotedProductRow.ad_asin,
            AdUploadPromotedProductRow.ad_sku,
        )
        .join(
            AdUploadFile,
            AdUploadFile.id == AdUploadPromotedProductRow.source_file_id,
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
            AdUploadPromotedProductRow.ad_asin.is_not(None),
            AdUploadPromotedProductRow.ad_sku.is_not(None),
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
    # ad 数据从 ad_upload_files 查 (C 表是 ad 报告的新体系)
    latest_ad_date: date | None = db.execute(
        select(func.max(AdUploadFile.report_date))
        .where(
            AdUploadFile.project_id == project_id,
            AdUploadFile.country == country,
            AdUploadFile.is_current.is_(True),
            AdUploadFile.report_type == "ad_promoted_product_report",
            AdUploadFile.report_date.is_not(None),
        )
    ).scalar()

    # 其他 3 种 report_type 仍从 analysis_source_files 读
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
            ("sales_report", "inventory_report", "business_report")
        ),
    )
    rows = db.execute(stmt).all()

    latest_sales_date: date | None = None
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
    no_cache: bool = False,
) -> dict[str, object]:
    normalized_country = normalize_country(country)
    normalized_start = parse_yyyy_mm_dd(start_date, "start_date")
    normalized_end = parse_yyyy_mm_dd(end_date, "end_date")

    if not no_cache:
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
        if no_cache:
            # 主动失效整个项目的 daily-analysis 缓存，让后续普通请求（刷新页面、
            # 切换日期范围 / 国家）也读到刚刷出来的新数据，而不是继续命中旧缓存。
            redis_service.invalidate_daily_analysis_cache(project_id)
        else:
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
            global_bucket.pending_order_qty += bucket.pending_order_qty
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


# 全部国家站点聚合：当前支持 US / DE /UK（与 utils/country.py 的 SUPPORTED_COUNTRIES 对齐）。
# 国家 → 源币种映射，用于跨币种→USD 折算。
ALL_COUNTRIES_AGGREGATION: tuple[str, ...] = ("US", "DE", "UK")
ALL_COUNTRIES_CURRENCY: dict[str, str] = {
    "US": "USD",
    "DE": "EUR",
    "UK": "GBP",
}


def _year_months_in_range(start_date: date, end_date: date) -> list[str]:
    """列出 start_date..end_date 范围内去重并按升序排列的 year_month。

    返回格式与 ``ExchangeRate.year_month`` 一致（'YYYY-MM'）。
    """
    months: set[str] = set()
    cursor = date(start_date.year, start_date.month, 1)
    end_first = date(end_date.year, end_date.month, 1)
    while cursor <= end_first:
        months.add(f"{cursor.year:04d}-{cursor.month:02d}")
        # step to next month
        if cursor.month == 12:
            cursor = date(cursor.year + 1, 1, 1)
        else:
            cursor = date(cursor.year, cursor.month + 1, 1)
    return sorted(months)


def _load_usd_factors_for_countries(
    db: Session,
    *,
    countries: tuple[str, ...],
    year_months: list[str],
) -> dict[tuple[str, str], Decimal]:
    """预加载各国在各月相对 USD 的转换因子。

    返回 {(country, year_month): source_to_usd_factor}。
    - 对源币种为 USD 的国家，factor = 1。
    - 对其他币种，factor = (source_to_cny_rate) / (usd_to_cny_rate)，与 commission
      recompute 同口径。
    - 缺失汇率时（连回退都没有）抛 HTTP 422，调用方在响应中能立刻看到哪一格没有数据。
    """
    factors: dict[tuple[str, str], Decimal] = {}
    if not year_months:
        return factors

    for country_value in countries:
        currency = ALL_COUNTRIES_CURRENCY.get(country_value)
        if currency is None:
            continue
        for ym in year_months:
            if currency == "USD":
                factors[(country_value, ym)] = Decimal("1")
                continue

            source_rate = exchange_rate_service.get_exchange_rate_by_currency_month_with_fallback(
                db, currency=currency, year_month=ym
            )
            usd_rate = exchange_rate_service.get_exchange_rate_by_currency_month_with_fallback(
                db, currency="USD", year_month=ym
            )
            if source_rate is None or usd_rate is None:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=(
                        f"exchange rate missing for country={country_value} "
                        f"({currency}) or USD in {ym} (no fallback available); "
                        "cannot convert all-countries aggregation to USD"
                    ),
                )
            source_to_cny = Decimal(str(source_rate.rate))
            usd_to_cny = Decimal(str(usd_rate.rate))
            if usd_to_cny == 0:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=f"USD->CNY rate is zero for {ym}",
                )
            factors[(country_value, ym)] = source_to_cny / usd_to_cny
    return factors


def _convert_bucket_amounts_to_usd(
    buckets: dict[tuple[str, str], _MetricBucket],
    *,
    country: str,
    usd_factors: dict[tuple[str, str], Decimal],
) -> None:
    """原地把一个国家的 buckets 内的金额字段（sales_amount / ad_spend /
    business_sales_amount）按各 row 日期的 year_month 折算成 USD。

    非金额字段（order_qty / impressions / clicks / ...）保持不变。
    """
    factor_by_year_month: dict[str, Decimal] = {
        ym: usd_factors[(country, ym)]
        for (_c, ym) in usd_factors.keys()
        if _c == country
    }
    if not factor_by_year_month:
        return

    for (date_text, _sku), bucket in buckets.items():
        # date_text 形如 'YYYY-MM-DD'
        ym = date_text[:7]
        factor = factor_by_year_month.get(ym)
        if factor is None:
            # 边界情况：start_date/end_date 跨多月，但预加载的 year_month 列表中
            # 缺了某月；这种 row 保持原币种原值，不参与 USD 聚合。
            continue
        bucket.sales_amount = (bucket.sales_amount * factor).quantize(
            Decimal("0.01"), rounding=ROUND_HALF_UP
        )
        bucket.ad_spend = (bucket.ad_spend * factor).quantize(
            Decimal("0.01"), rounding=ROUND_HALF_UP
        )
        bucket.business_sales_amount = (bucket.business_sales_amount * factor).quantize(
            Decimal("0.01"), rounding=ROUND_HALF_UP
        )


def build_daily_analysis_all_countries(
    db: Session,
    *,
    project_id: int,
    start_date: str,
    end_date: str,
    sku: str | None = None,
) -> dict[str, object]:
    """跨所有支持的国家站点聚合单项目数据，并按 exchange_rates 表把金额字段折算成 USD。

    行为约定：
    - 对每个国家独立调用 *_metrics loader，再把每个国家的 buckets 合并到
      ``global_buckets``。同一 (date, sku) 在不同国家的数据点会被相加。
    - 在合并到 global 之前，每个国家的金额字段（sales_amount / ad_spend /
      business_sales_amount）已按当月 ``source_to_cny / usd_to_cny`` 因子
      折算成 USD；非金额字段（order_qty / impressions / clicks / sessions /
      page_views / units_ordered / available_qty / in_transit_qty /
      ad_orders）保持原值。
    - 不应用 sku 过滤（与 all_projects 一致：单 SKU 不能跨国家求和）。
    - 返回 ``country_breakdown`` 给出按国家分桶的明细，每行同时带 ``currency``
      字段标识源币种，方便前端展示"原始/折算后"对照。
    - 汇率预加载：按 (country, year_month) 一次性获取并按月回退；若某月汇率
      缺失（含回退）则整个请求返回 422，避免出现"半截已折算、半截未折算"
      的不一致数据。
    """
    project = _get_project_or_404(db, project_id)
    normalized_start = parse_yyyy_mm_dd(start_date, "start_date")
    normalized_end = parse_yyyy_mm_dd(end_date, "end_date")

    if normalized_start > normalized_end:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="start_date cannot be greater than end_date",
        )

    year_months = _year_months_in_range(normalized_start, normalized_end)
    usd_factors = _load_usd_factors_for_countries(
        db,
        countries=ALL_COUNTRIES_AGGREGATION,
        year_months=year_months,
    )

    global_buckets: dict[tuple[str, str], _MetricBucket] = {}
    global_in_transit_map: dict[str, int] = {}
    country_breakdown: dict[str, dict[str, object]] = {}
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

    for country_value in ALL_COUNTRIES_AGGREGATION:
        detail_buckets: dict[tuple[str, str], _MetricBucket] = {}

        _load_sales_metrics(
            db,
            detail_buckets=detail_buckets,
            project_id=project_id,
            country=country_value,
            start_date=normalized_start,
            end_date=normalized_end,
        )
        _load_ad_metrics(
            db,
            detail_buckets=detail_buckets,
            project_id=project_id,
            country=country_value,
            start_date=normalized_start,
            end_date=normalized_end,
        )
        _load_inventory_metrics(
            db,
            detail_buckets=detail_buckets,
            project_id=project_id,
            country=country_value,
            start_date=normalized_start,
            end_date=normalized_end,
        )
        asin_to_sku_map = _build_asin_to_sku_map(
            db,
            project_id=project_id,
            country=country_value,
            start_date=normalized_start,
            end_date=normalized_end,
        )
        _load_business_metrics(
            db,
            detail_buckets=detail_buckets,
            project_id=project_id,
            country=country_value,
            start_date=normalized_start,
            end_date=normalized_end,
            asin_to_sku_map=asin_to_sku_map,
        )

        # 折算该国家的金额字段到 USD（不动非金额字段），然后再做 country 维度聚合。
        _convert_bucket_amounts_to_usd(
            detail_buckets,
            country=country_value,
            usd_factors=usd_factors,
        )

        country_detail, country_summary = _aggregate_buckets(
            detail_buckets, sku_filter=None,
        )
        country_in_transit_map = _load_in_transit_quantities(
            db, project_id, country_value
        )
        for row in country_detail:
            row["in_transit_qty"] = country_in_transit_map.get(row["sku"], 0)
            row["country"] = country_value
        country_breakdown[country_value] = {
            "summary_rows": country_summary,
            "detail_rows": country_detail,
            "currency": "USD",  # 折算后
            "source_currency": ALL_COUNTRIES_CURRENCY.get(country_value, "USD"),
        }

        for key, bucket in detail_buckets.items():
            global_bucket = global_buckets.setdefault(key, _MetricBucket())
            _set_asin_if_blank(global_bucket, bucket.asin)
            global_bucket.order_qty += bucket.order_qty
            global_bucket.pending_order_qty += bucket.pending_order_qty
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

        for sku_key, qty in country_in_transit_map.items():
            global_in_transit_map[sku_key] = global_in_transit_map.get(sku_key, 0) + qty

        proj_dates = _load_latest_available_dates(
            db, project_id=project_id, country=country_value
        )
        for key, latest_date in proj_dates.items():
            if latest_date is None:
                continue
            report_type = report_type_key_map.get(key)
            if report_type is None:
                continue
            current = available_dates[report_type]
            if not current or latest_date > current[0]:
                available_dates[report_type] = [latest_date]

    global_detail, global_summary = _aggregate_buckets(global_buckets, sku_filter=None)
    for row in global_detail:
        row["in_transit_qty"] = global_in_transit_map.get(row["sku"], 0)

    return {
        "console": {
            "project_id": int(project.id),
            "project_name": project.project_name,
            "country": "ALL",
            "start_date": normalized_start.isoformat(),
            "end_date": normalized_end.isoformat(),
            "requested_days": len(
                [item.isoformat() for item in date_range(normalized_start, normalized_end)]
            ),
            "summary_days": len(global_summary),
            "detail_rows": len(global_detail),
            "sales_source_days": 0,
            "ad_source_days": 0,
            "inventory_source_days": 0,
            "business_source_days": 0,
            "missing_dates": [],
            "latest_sales_date": None,
            "latest_ad_date": None,
            "latest_inventory_date": None,
            "latest_business_date": None,
        },
        "summary_rows": global_summary,
        "detail_rows": global_detail,
        "available_dates": available_dates,
        "country_breakdown": country_breakdown,
        "currency": "USD",
        "currency_note": "金额字段已按当月 CNY 中转折算为 USD 统一展示；非金额字段（订单/曝光/点击/库存等）保持原值。",
    }

def build_daily_analysis_all_projects_countries(
    db: Session,
    *,
    project_ids: list[int],
    start_date: str,
    end_date: str,
    sku: str | None = None,
) -> dict[str, object]:
    """BLF-913：全部项目 × 全部国家站点聚合（USD 基准）。

    行为约定（合并 all_projects 与 all_countries 两条既有路径的口径）：
    - 对每个 (project, country) 组合独立装载 metrics，先把该国家金额字段按
      当月 ``source_to_cny / usd_to_cny`` 因子折算成 USD，再合并进 global；
      非金额字段保持原值（复用 ``_convert_bucket_amounts_to_usd``）。
    - ``country_breakdown[country]``：该国家内跨项目合并后的分桶（折算后 USD）。
    - ``project_breakdown[project_id]``：该项目跨 US/DE/UK 合并后的分桶
      （折算后 USD），key 与 all_projects 响应一致，前端可无缝复用。
    - 不应用 sku 过滤（单 SKU 无法跨国家/跨项目求和，两条既有路径同款约定）。
    - 汇率预加载复用 ``_load_usd_factors_for_countries``：某月汇率缺失（连
      回退都没有）时整个请求 422，避免半截折算的不一致数据。
    """
    normalized_start = parse_yyyy_mm_dd(start_date, "start_date")
    normalized_end = parse_yyyy_mm_dd(end_date, "end_date")

    if normalized_start > normalized_end:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="start_date cannot be greater than end_date",
        )

    year_months = _year_months_in_range(normalized_start, normalized_end)
    usd_factors = _load_usd_factors_for_countries(
        db,
        countries=ALL_COUNTRIES_AGGREGATION,
        year_months=year_months,
    )

    global_buckets: dict[tuple[str, str], _MetricBucket] = {}
    global_in_transit_map: dict[str, int] = {}
    # 国家 → 跨项目合并 buckets / 在途量（单趟扫描同时累积三路分桶）。
    country_by_project_buckets: dict[str, dict[tuple[str, str], _MetricBucket]] = {}
    country_in_transit_maps: dict[str, dict[str, int]] = {}
    country_breakdown: dict[str, dict[str, object]] = {}
    project_breakdown: dict[int, dict[str, object]] = {}
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

    def _merge_buckets(
        target: dict[tuple[str, str], _MetricBucket],
        source: dict[tuple[str, str], _MetricBucket],
    ) -> None:
        for key, bucket in source.items():
            target_bucket = target.setdefault(key, _MetricBucket())
            _set_asin_if_blank(target_bucket, bucket.asin)
            target_bucket.order_qty += bucket.order_qty
            target_bucket.pending_order_qty += bucket.pending_order_qty
            target_bucket.sales_amount += bucket.sales_amount
            target_bucket.impressions += bucket.impressions
            target_bucket.clicks += bucket.clicks
            target_bucket.ad_spend += bucket.ad_spend
            target_bucket.ad_orders += bucket.ad_orders
            target_bucket.available_qty += bucket.available_qty
            target_bucket.page_views += bucket.page_views
            target_bucket.units_ordered += bucket.units_ordered
            target_bucket.sessions += bucket.sessions
            target_bucket.business_sales_amount += bucket.business_sales_amount

    for project_id in project_ids:
        project = _get_project_or_404(db, project_id)
        project_buckets: dict[tuple[str, str], _MetricBucket] = {}
        project_in_transit_map: dict[str, int] = {}

        for country_value in ALL_COUNTRIES_AGGREGATION:
            detail_buckets: dict[tuple[str, str], _MetricBucket] = {}

            _load_sales_metrics(
                db,
                detail_buckets=detail_buckets,
                project_id=project_id,
                country=country_value,
                start_date=normalized_start,
                end_date=normalized_end,
            )
            _load_ad_metrics(
                db,
                detail_buckets=detail_buckets,
                project_id=project_id,
                country=country_value,
                start_date=normalized_start,
                end_date=normalized_end,
            )
            _load_inventory_metrics(
                db,
                detail_buckets=detail_buckets,
                project_id=project_id,
                country=country_value,
                start_date=normalized_start,
                end_date=normalized_end,
            )
            asin_to_sku_map = _build_asin_to_sku_map(
                db,
                project_id=project_id,
                country=country_value,
                start_date=normalized_start,
                end_date=normalized_end,
            )
            _load_business_metrics(
                db,
                detail_buckets=detail_buckets,
                project_id=project_id,
                country=country_value,
                start_date=normalized_start,
                end_date=normalized_end,
                asin_to_sku_map=asin_to_sku_map,
            )

            # 折算该国家金额到 USD，再做 project / country / global 三路合并。
            _convert_bucket_amounts_to_usd(
                detail_buckets,
                country=country_value,
                usd_factors=usd_factors,
            )

            _merge_buckets(project_buckets, detail_buckets)
            _merge_buckets(
                country_by_project_buckets.setdefault(country_value, {}),
                detail_buckets,
            )

            cell_in_transit_map = _load_in_transit_quantities(
                db, project_id, country_value
            )
            for sku_key, qty in cell_in_transit_map.items():
                project_in_transit_map[sku_key] = (
                    project_in_transit_map.get(sku_key, 0) + qty
                )
                country_in_transit_maps.setdefault(country_value, {})[sku_key] = (
                    country_in_transit_maps.get(country_value, {}).get(sku_key, 0) + qty
                )
                global_in_transit_map[sku_key] = (
                    global_in_transit_map.get(sku_key, 0) + qty
                )

            proj_dates = _load_latest_available_dates(
                db, project_id=project_id, country=country_value
            )
            for key, latest_date in proj_dates.items():
                if latest_date is None:
                    continue
                report_type = report_type_key_map.get(key)
                if report_type is None:
                    continue
                current = available_dates[report_type]
                if not current or latest_date > current[0]:
                    available_dates[report_type] = [latest_date]

        project_detail, project_summary = _aggregate_buckets(
            project_buckets, sku_filter=None
        )
        for row in project_detail:
            row["in_transit_qty"] = project_in_transit_map.get(row["sku"], 0)
        project_breakdown[int(project.id)] = {
            "project_name": project.project_name,
            "summary_rows": project_summary,
            "detail_rows": project_detail,
        }

        _merge_buckets(global_buckets, project_buckets)

    for country_value in ALL_COUNTRIES_AGGREGATION:
        country_detail, country_summary = _aggregate_buckets(
            country_by_project_buckets.get(country_value, {}), sku_filter=None
        )
        in_transit_map = country_in_transit_maps.get(country_value, {})
        for row in country_detail:
            row["in_transit_qty"] = in_transit_map.get(row["sku"], 0)
            row["country"] = country_value
        country_breakdown[country_value] = {
            "summary_rows": country_summary,
            "detail_rows": country_detail,
            "currency": "USD",
            "source_currency": ALL_COUNTRIES_CURRENCY.get(country_value, "USD"),
        }

    global_detail, global_summary = _aggregate_buckets(global_buckets, sku_filter=None)
    for row in global_detail:
        row["in_transit_qty"] = global_in_transit_map.get(row["sku"], 0)

    return {
        "console": {
            "project_id": 0,
            "project_name": "全部项目",
            "country": "ALL",
            "start_date": normalized_start.isoformat(),
            "end_date": normalized_end.isoformat(),
            "requested_days": len(
                [item.isoformat() for item in date_range(normalized_start, normalized_end)]
            ),
            "summary_days": len(global_summary),
            "detail_rows": len(global_detail),
            "sales_source_days": 0,
            "ad_source_days": 0,
            "inventory_source_days": 0,
            "business_source_days": 0,
            "missing_dates": [],
            "latest_sales_date": None,
            "latest_ad_date": None,
            "latest_inventory_date": None,
            "latest_business_date": None,
        },
        "summary_rows": global_summary,
        "detail_rows": global_detail,
        "available_dates": available_dates,
        "project_breakdown": project_breakdown,
        "country_breakdown": country_breakdown,
        "currency": "USD",
        "currency_note": "金额字段已按当月 CNY 中转折算为 USD 统一展示；非金额字段（订单/曝光/点击/库存等）保持原值。",
    }
