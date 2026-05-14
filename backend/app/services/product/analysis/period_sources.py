"""Period source management functions."""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import Select, and_, func, or_, select
from sqlalchemy.orm import Session

from app.models import (
    AnalysisSourceFile,
    AnalysisPT1Calculation,
    AnalysisPTSKUDetail,
    SkuRecord,
    Project,
)
from app.services import exchange_rate_service
from app.services.product._internal import _get_project_by_name, _is_single_full_week
from app.services.product.persistence import (
    ensure_tables,
    persist_product_analysis_pt1_calculation,
    _load_project_product_mapping,
)
from app.services.product.business import (
    _build_business_df_from_source,
    _build_business_df_from_sources,
)
from app.services.product.ad import (
    _build_ad_df_from_source,
    _build_ad_df_from_sources,
)
from app.services.payment import (
    build_df_from_source,
    build_df_from_sources,
)
from app.tasks.scripts import product_analysis as product_analysis_script
from app.services.report_type_service import AD_PRODUCT_REPORT
from app.utils.country import normalize_country as _normalize_country
from app.utils.constants import PERIODIC_REPORT_TYPES


def _list_recomputable_weekly_period_sources(
    db: Session,
    *,
    project_id: int,
    country: str,
    start_date: date | None,
    end_date: date | None,
    current_only: bool,
) -> list[dict[str, Any]]:
    """List period-based source groupings suitable for PT1 recomputation."""
    stmt = select(AnalysisSourceFile).where(
        AnalysisSourceFile.project_id == project_id,
        AnalysisSourceFile.report_type.in_(
            ('business_report', AD_PRODUCT_REPORT, 'payment_report')
        ),
        AnalysisSourceFile.country == country,
    )
    if current_only:
        stmt = stmt.where(AnalysisSourceFile.is_current.is_(True))
    if start_date is not None:
        stmt = stmt.where(AnalysisSourceFile.period_end_date >= start_date)
    if end_date is not None:
        stmt = stmt.where(AnalysisSourceFile.period_start_date <= end_date)

    rows = db.execute(
        stmt.order_by(
            AnalysisSourceFile.period_start_date.asc(),
            AnalysisSourceFile.period_end_date.asc(),
            AnalysisSourceFile.report_type.asc(),
            AnalysisSourceFile.version.desc(),
        )
    ).scalars().all()

    by_period: dict[tuple[date, date], dict[str, AnalysisSourceFile]] = {}
    for row in rows:
        if row.period_start_date is None or row.period_end_date is None:
            continue
        key = (row.period_start_date, row.period_end_date)
        period_map = by_period.setdefault(key, {})
        if row.report_type not in period_map:
            period_map[row.report_type] = row

    periods: list[dict[str, Any]] = []
    for (period_start_date, period_end_date), source_map in sorted(by_period.items()):
        if {'business_report', AD_PRODUCT_REPORT, 'payment_report'} - set(source_map.keys()):
            continue
        periods.append(
            {
                'report_start_date': period_start_date,
                'report_end_date': period_end_date,
                'business_report_source_id': int(source_map['business_report'].id),
                'ad_report_source_id': int(source_map[AD_PRODUCT_REPORT].id),
                'payment_report_source_id': int(source_map['payment_report'].id),
            }
        )
    return periods


def list_weekly_product_analysis_from_details(
    db: Session,
    *,
    project_id: int,
    country: str = 'US',
    start_date: date | None = None,
    end_date: date | None = None,
    current_only: bool = True,
) -> list[dict[str, Any]]:
    ensure_tables(db)
    project = db.get(Project, project_id)
    if project is None:
        return []
    normalized_country = _normalize_country(country)
    known_skus, known_asins = _load_project_product_mapping(db, project.project_name, normalized_country)
    known_skus_ci = {value.lower() for value in known_skus}
    known_asins_ci = {value.lower() for value in known_asins}
    scope_filters = []
    if known_skus_ci:
        scope_filters.append(func.lower(func.coalesce(AnalysisPTSKUDetail.sku, '')).in_(known_skus_ci))
    if known_asins_ci:
        scope_filters.append(func.lower(func.coalesce(AnalysisPTSKUDetail.asin, '')).in_(known_asins_ci))
    if not scope_filters:
        return []

    stmt = (
        select(
            AnalysisPT1Calculation.id.label('pt1_id'),
            AnalysisPT1Calculation.project_id.label('project_id'),
            AnalysisPT1Calculation.project_name.label('project_name'),
            AnalysisPT1Calculation.report_start_date.label('report_start_date'),
            AnalysisPT1Calculation.report_end_date.label('report_end_date'),
            AnalysisPT1Calculation.version.label('version'),
            AnalysisPT1Calculation.is_current.label('is_current'),
            func.count(AnalysisPTSKUDetail.id).label('row_count'),
            func.coalesce(func.sum(AnalysisPTSKUDetail.actual_sales_amount), 0).label('total_sales'),
            func.coalesce(func.sum(AnalysisPTSKUDetail.actual_sales_units), 0).label('total_units'),
            func.coalesce(func.sum(AnalysisPTSKUDetail.ad_spend), 0).label('total_ad_spend'),
        )
        .select_from(AnalysisPT1Calculation)
        .join(AnalysisPTSKUDetail, AnalysisPTSKUDetail.pt1_calculation_id == AnalysisPT1Calculation.id)
        .where(AnalysisPT1Calculation.project_id == project_id)
        .where(AnalysisPT1Calculation.country == normalized_country)
        .where(AnalysisPTSKUDetail.country == normalized_country)
        .where(or_(*scope_filters))
        .group_by(
            AnalysisPT1Calculation.id,
            AnalysisPT1Calculation.project_id,
            AnalysisPT1Calculation.project_name,
            AnalysisPT1Calculation.report_start_date,
            AnalysisPT1Calculation.report_end_date,
            AnalysisPT1Calculation.version,
            AnalysisPT1Calculation.is_current,
        )
        .order_by(AnalysisPT1Calculation.report_start_date.desc(), AnalysisPT1Calculation.id.desc())
    )
    if current_only:
        stmt = stmt.where(AnalysisPT1Calculation.is_current.is_(True))
    if start_date is not None:
        stmt = stmt.where(AnalysisPT1Calculation.report_end_date >= start_date)
    if end_date is not None:
        stmt = stmt.where(AnalysisPT1Calculation.report_start_date <= end_date)

    rows = db.execute(stmt).all()
    return [
        {
            'id': int(item.pt1_id),
            'project_id': int(item.project_id),
            'project_name': item.project_name,
            'country': normalized_country,
            'report_start_date': item.report_start_date,
            'report_end_date': item.report_end_date,
            'version': int(item.version),
            'is_current': bool(item.is_current),
            'row_count': int(item.row_count or 0),
            'total_sales': float(item.total_sales or 0),
            'total_units': int(item.total_units or 0),
            'total_ad_spend': float(item.total_ad_spend or 0),
        }
        for item in rows
    ]


def _list_history_weekly_period_sources(
    db: Session,
    *,
    project_id: int,
    country: str,
    start_date: date | None,
    end_date: date | None,
    current_only: bool,
) -> list[dict[str, Any]]:
    normalized_country = _normalize_country(country)
    periods_by_key: dict[tuple[date, date], dict[str, Any]] = {}

    for item in _list_recomputable_weekly_period_sources(
        db,
        project_id=project_id,
        country=normalized_country,
        start_date=start_date,
        end_date=end_date,
        current_only=current_only,
    ):
        key = (item['report_start_date'], item['report_end_date'])
        num_days = (item['report_end_date'] - item['report_start_date']).days + 1
        periods_by_key[key] = {
            'report_start_date': item['report_start_date'],
            'report_end_date': item['report_end_date'],
            'business_report_source_ids': [int(item['business_report_source_id'])],
            'ad_report_source_ids': [int(item['ad_report_source_id'])],
            'payment_report_source_ids': [int(item['payment_report_source_id'])],
            'is_partial': False,
            'completeness': {
                'total_days': num_days,
                'available_business_days': num_days,
                'available_ad_days': num_days,
                'business_missing_dates': [],
                'ad_missing_dates': [],
                'payment_covered': True,
                'payment_type': 'period',
                'payment_missing': False,
            },
        }

    daily_stmt = select(AnalysisSourceFile).where(
        AnalysisSourceFile.project_id == project_id,
        AnalysisSourceFile.report_type.in_(('business_report', AD_PRODUCT_REPORT)),
        AnalysisSourceFile.country == normalized_country,
        AnalysisSourceFile.report_date.is_not(None),
    )
    if current_only:
        daily_stmt = daily_stmt.where(AnalysisSourceFile.is_current.is_(True))
    if start_date is not None:
        daily_stmt = daily_stmt.where(AnalysisSourceFile.report_date >= start_date)
    if end_date is not None:
        daily_stmt = daily_stmt.where(AnalysisSourceFile.report_date <= end_date)

    daily_rows = db.execute(
        daily_stmt.order_by(
            AnalysisSourceFile.report_type.asc(),
            AnalysisSourceFile.report_date.asc(),
            AnalysisSourceFile.version.desc(),
            AnalysisSourceFile.id.desc(),
        )
    ).scalars().all()

    daily_sources: dict[str, dict[date, AnalysisSourceFile]] = {
        'business_report': {},
        AD_PRODUCT_REPORT: {},
    }
    for row in daily_rows:
        if row.report_date is None:
            continue
        report_map = daily_sources.setdefault(row.report_type, {})
        report_map.setdefault(row.report_date, row)

    known_dates = sorted({
        *daily_sources['business_report'].keys(),
        *daily_sources[AD_PRODUCT_REPORT].keys(),
    })
    if not known_dates:
        return list(periods_by_key[key] for key in sorted(periods_by_key) if key[0] != key[1]) if periods_by_key else []

    effective_start = start_date or known_dates[0]
    effective_end = end_date or known_dates[-1]
    if effective_start > effective_end:
        return list(periods_by_key[key] for key in sorted(periods_by_key) if key[0] != key[1]) if periods_by_key else []

    # Query periodic business report sources
    business_period_stmt = select(AnalysisSourceFile).where(
        AnalysisSourceFile.project_id == project_id,
        AnalysisSourceFile.report_type == 'business_report',
        AnalysisSourceFile.country == normalized_country,
        AnalysisSourceFile.report_date.is_(None),
        AnalysisSourceFile.period_start_date.is_not(None),
        AnalysisSourceFile.period_end_date.is_not(None),
    )
    if current_only:
        business_period_stmt = business_period_stmt.where(AnalysisSourceFile.is_current.is_(True))
    if start_date is not None:
        business_period_stmt = business_period_stmt.where(AnalysisSourceFile.period_end_date >= start_date)
    if end_date is not None:
        business_period_stmt = business_period_stmt.where(AnalysisSourceFile.period_start_date <= end_date)

    business_period_rows = db.execute(
        business_period_stmt.order_by(
            AnalysisSourceFile.period_start_date.asc(),
            AnalysisSourceFile.period_end_date.asc(),
            AnalysisSourceFile.version.desc(),
            AnalysisSourceFile.id.desc(),
        )
    ).scalars().all()

    # Query periodic ad report sources
    ad_period_stmt = select(AnalysisSourceFile).where(
        AnalysisSourceFile.project_id == project_id,
        AnalysisSourceFile.report_type == AD_PRODUCT_REPORT,
        AnalysisSourceFile.country == normalized_country,
        AnalysisSourceFile.report_date.is_(None),
        AnalysisSourceFile.period_start_date.is_not(None),
        AnalysisSourceFile.period_end_date.is_not(None),
    )
    if current_only:
        ad_period_stmt = ad_period_stmt.where(AnalysisSourceFile.is_current.is_(True))
    if start_date is not None:
        ad_period_stmt = ad_period_stmt.where(AnalysisSourceFile.period_end_date >= start_date)
    if end_date is not None:
        ad_period_stmt = ad_period_stmt.where(AnalysisSourceFile.period_start_date <= end_date)

    ad_period_rows = db.execute(
        ad_period_stmt.order_by(
            AnalysisSourceFile.period_start_date.asc(),
            AnalysisSourceFile.period_end_date.asc(),
            AnalysisSourceFile.version.desc(),
            AnalysisSourceFile.id.desc(),
        )
    ).scalars().all()

    payment_stmt = select(AnalysisSourceFile).where(
        AnalysisSourceFile.project_id == project_id,
        AnalysisSourceFile.report_type == 'payment_report',
        AnalysisSourceFile.country == normalized_country,
        or_(
            and_(
                AnalysisSourceFile.report_date.is_not(None),
                AnalysisSourceFile.report_date >= effective_start,
                AnalysisSourceFile.report_date <= effective_end,
            ),
            and_(
                AnalysisSourceFile.report_date.is_(None),
                AnalysisSourceFile.period_start_date <= effective_end,
                AnalysisSourceFile.period_end_date >= effective_start,
            ),
        ),
    )
    if current_only:
        payment_stmt = payment_stmt.where(AnalysisSourceFile.is_current.is_(True))

    payment_rows = db.execute(
        payment_stmt.order_by(
            AnalysisSourceFile.report_date.asc().nulls_last(),
            AnalysisSourceFile.period_start_date.asc().nulls_last(),
            AnalysisSourceFile.version.desc(),
            AnalysisSourceFile.id.desc(),
        )
    ).scalars().all()

    payment_daily_by_date: dict[date, AnalysisSourceFile] = {}
    payment_period_rows: list[AnalysisSourceFile] = []
    for row in payment_rows:
        if row.report_date is not None:
            payment_daily_by_date.setdefault(row.report_date, row)
            continue
        payment_period_rows.append(row)

    weeks: dict[tuple[int, int], list[date]] = {}
    current = effective_start
    while current <= effective_end:
        week_key = (current.isocalendar()[0], current.isocalendar()[1])
        weeks.setdefault(week_key, []).append(current)
        current += timedelta(days=1)

    for week_key in sorted(weeks):
        week_dates = weeks[week_key]

        # ========== Business Report Logic ==========
        business_source_ids: list[int] = []
        business_covered = False
        business_type = 'none'
        business_missing_dates: list[str] = []

        if all(day in daily_sources['business_report'] for day in week_dates):
            business_source_ids = [int(daily_sources['business_report'][day].id) for day in week_dates]
            business_covered = True
            business_type = 'daily'
        else:
            covering_business = next(
                (
                    row for row in business_period_rows
                    if row.period_start_date <= week_dates[0]
                    and row.period_end_date >= week_dates[-1]
                ),
                None,
            )
            if covering_business is not None:
                business_source_ids = [int(covering_business.id)]
                business_covered = True
                business_type = 'period'
            else:
                available_business = [daily_sources['business_report'][day] for day in week_dates if day in daily_sources['business_report']]
                business_source_ids = [int(row.id) for row in available_business]
                business_missing_dates = [d.isoformat() for d in week_dates if d not in daily_sources['business_report']]
                business_covered = False
                business_type = 'partial' if business_source_ids else 'none'

        # ========== Ad Report Logic ==========
        ad_source_ids: list[int] = []
        ad_covered = False
        ad_type = 'none'
        ad_missing_dates: list[str] = []

        if all(day in daily_sources[AD_PRODUCT_REPORT] for day in week_dates):
            ad_source_ids = [int(daily_sources[AD_PRODUCT_REPORT][day].id) for day in week_dates]
            ad_covered = True
            ad_type = 'daily'
        else:
            covering_ad = next(
                (
                    row for row in ad_period_rows
                    if row.period_start_date <= week_dates[0]
                    and row.period_end_date >= week_dates[-1]
                ),
                None,
            )
            if covering_ad is not None:
                ad_source_ids = [int(covering_ad.id)]
                ad_covered = True
                ad_type = 'period'
            else:
                available_ad = [daily_sources[AD_PRODUCT_REPORT][day] for day in week_dates if day in daily_sources[AD_PRODUCT_REPORT]]
                ad_source_ids = [int(row.id) for row in available_ad]
                ad_missing_dates = [d.isoformat() for d in week_dates if d not in daily_sources[AD_PRODUCT_REPORT]]
                ad_covered = False
                ad_type = 'partial' if ad_source_ids else 'none'

        # ========== Payment Report Logic ==========
        payment_source_ids: list[int] = []
        payment_covered = False
        payment_type = 'none'
        payment_missing_dates_list: list[str] = []

        if all(day in payment_daily_by_date for day in week_dates):
            payment_source_ids = [int(payment_daily_by_date[day].id) for day in week_dates]
            payment_covered = True
            payment_type = 'daily'
        else:
            covering_payment = next(
                (
                    row for row in payment_period_rows
                    if row.period_start_date is not None
                    and row.period_end_date is not None
                    and row.period_start_date <= week_dates[0]
                    and row.period_end_date >= week_dates[-1]
                ),
                None,
            )
            if covering_payment is not None:
                payment_source_ids = [int(covering_payment.id)]
                payment_covered = True
                payment_type = 'period'
            else:
                payment_missing_dates_list = [d.isoformat() for d in week_dates if d not in payment_daily_by_date]
                partial_payment_ids = [int(payment_daily_by_date[day].id) for day in week_dates if day in payment_daily_by_date]
                if partial_payment_ids:
                    payment_source_ids = partial_payment_ids
                    payment_covered = False
                    payment_type = 'partial'
                else:
                    payment_covered = False
                    payment_type = 'none'

        # Skip if no data at all
        if not business_source_ids and not ad_source_ids:
            continue

        key = (week_dates[0], week_dates[-1])
        entry: dict[str, Any] = {
            'report_start_date': week_dates[0],
            'report_end_date': week_dates[-1],
            'business_report_source_ids': business_source_ids,
            'ad_report_source_ids': ad_source_ids,
            'payment_report_source_ids': payment_source_ids,
            'is_partial': bool(business_missing_dates or ad_missing_dates or not payment_covered),
            'completeness': {
                'total_days': len(week_dates),
                'available_business_days': len(business_source_ids),
                'available_ad_days': len(ad_source_ids),
                'business_missing_dates': business_missing_dates,
                'ad_missing_dates': ad_missing_dates,
                'business_type': business_type,
                'ad_type': ad_type,
                'payment_covered': payment_covered,
                'payment_type': payment_type,
                'payment_missing': not payment_covered,
                'payment_missing_dates': payment_missing_dates_list if payment_type in ('partial', 'none') else [],
            },
        }

        periods_by_key[key] = entry

    periods_by_key = {
        key: value
        for key, value in periods_by_key.items()
        if key[0] != key[1]
    }

    return [periods_by_key[key] for key in sorted(periods_by_key)]