"""Product calculation data availability checks."""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from sqlalchemy import select, and_, or_
from sqlalchemy.orm import Session

from app.models import AnalysisSourceFile
from app.services.report_type_service import AD_PRODUCT_REPORT
from app.utils.country import normalize_country as _normalize_country
from app.utils.constants import PERIODIC_REPORT_TYPES


def check_product_calculation_data_availability(
    db: Session,
    *,
    project_id: int,
    country: str,
    start_date: date,
    end_date: date,
) -> dict[str, Any]:
    normalized_country = _normalize_country(country)

    all_dates: set[date] = set()
    d = start_date
    while d <= end_date:
        all_dates.add(d)
        d += timedelta(days=1)

    def _daily_dates(report_type: str) -> set[date]:
        """Get dates covered by daily reports only (for missing check)."""
        rows = db.execute(
            select(AnalysisSourceFile.report_date).where(
                AnalysisSourceFile.project_id == project_id,
                AnalysisSourceFile.report_type == report_type,
                AnalysisSourceFile.country == normalized_country,
                AnalysisSourceFile.report_date >= start_date,
                AnalysisSourceFile.report_date <= end_date,
                AnalysisSourceFile.report_date.is_not(None),
            )
        ).scalars().all()
        return {r for r in rows if r is not None}

    def _period_covered_dates(report_type: str) -> list[dict[str, Any]]:
        """Get periodic data coverage info (start, end, source_id)."""
        if report_type not in PERIODIC_REPORT_TYPES:
            return []
        rows = db.execute(
            select(
                AnalysisSourceFile.period_start_date,
                AnalysisSourceFile.period_end_date,
                AnalysisSourceFile.id,
            ).where(
                AnalysisSourceFile.project_id == project_id,
                AnalysisSourceFile.report_type == report_type,
                AnalysisSourceFile.country == normalized_country,
                AnalysisSourceFile.report_date.is_(None),
                AnalysisSourceFile.period_start_date <= end_date,
                AnalysisSourceFile.period_end_date >= start_date,
            )
        ).all()
        result = []
        for row in rows:
            if row.period_start_date is None or row.period_end_date is None:
                continue
            covered_dates = set()
            cur = max(row.period_start_date, start_date)
            cur_end = min(row.period_end_date, end_date)
            while cur <= cur_end:
                covered_dates.add(cur)
                cur += timedelta(days=1)
            result.append({
                'period_start_date': row.period_start_date.isoformat(),
                'period_end_date': row.period_end_date.isoformat(),
                'source_id': int(row.id),
                'covered_dates': sorted([d.isoformat() for d in covered_dates]),
            })
        return result

    def _all_covered_dates(report_type: str) -> set[date]:
        """Get dates covered by either daily OR periodic reports."""
        covered: set[date] = set()
        covered.update(_daily_dates(report_type))
        for period in _period_covered_dates(report_type):
            for d_str in period['covered_dates']:
                covered.add(date.fromisoformat(d_str))
        return covered

    # Single-day data (for missing check)
    business_daily_dates = _daily_dates('business_report')
    ad_daily_dates = _daily_dates(AD_PRODUCT_REPORT)
    inventory_daily_dates = _daily_dates('inventory_report')

    # Periodic coverage info
    business_period_info = _period_covered_dates('business_report')
    ad_period_info = _period_covered_dates(AD_PRODUCT_REPORT)

    # All covered dates (daily + periodic)
    business_all_covered = _all_covered_dates('business_report')
    ad_all_covered = _all_covered_dates(AD_PRODUCT_REPORT)

    # Missing = total - daily (not affected by periodic)
    business_missing = sorted(all_dates - business_daily_dates)
    ad_missing = sorted(all_dates - ad_daily_dates)
    inventory_missing = sorted(all_dates - inventory_daily_dates)

    # Periodic only covered (no daily data for these dates)
    business_periodic_only = sorted(all_dates - business_daily_dates & business_all_covered)
    ad_periodic_only = sorted(all_dates - ad_daily_dates & ad_all_covered)

    daily_payment_rows = db.execute(
        select(
            AnalysisSourceFile.report_date,
            AnalysisSourceFile.period_start_date,
            AnalysisSourceFile.period_end_date,
            AnalysisSourceFile.id,
        ).where(
            AnalysisSourceFile.project_id == project_id,
            AnalysisSourceFile.report_type == 'payment_report',
            AnalysisSourceFile.country == normalized_country,
            AnalysisSourceFile.report_date >= start_date,
            AnalysisSourceFile.report_date <= end_date,
        )
    ).all()

    payment_daily_covered_dates = sorted({
        r.report_date.isoformat()
        for r in daily_payment_rows
        if r.report_date is not None
    })

    payment_period_rows = db.execute(
        select(
            AnalysisSourceFile.period_start_date,
            AnalysisSourceFile.period_end_date,
            AnalysisSourceFile.id,
        ).where(
            AnalysisSourceFile.project_id == project_id,
            AnalysisSourceFile.report_type == 'payment_report',
            AnalysisSourceFile.country == normalized_country,
            AnalysisSourceFile.report_date.is_(None),
            AnalysisSourceFile.period_start_date <= end_date,
            AnalysisSourceFile.period_end_date >= start_date,
        )
    ).all()
    payment_periods = [
        {'period_start_date': r.period_start_date, 'period_end_date': r.period_end_date, 'source_id': int(r.id)}
        for r in payment_period_rows
    ]

    payment_period_covered_dates: set[date] = set()
    for row in payment_period_rows:
        if row.period_start_date is None or row.period_end_date is None:
            continue
        cur = max(row.period_start_date, start_date)
        cur_end = min(row.period_end_date, end_date)
        while cur <= cur_end:
            payment_period_covered_dates.add(cur)
            cur += timedelta(days=1)

    payment_full_period_covered = all_dates <= payment_period_covered_dates

    def _iso_week_key(d: date) -> tuple[int, int]:
        return d.isocalendar()[0], d.isocalendar()[1]

    all_dates_sorted = sorted(all_dates)
    iso_weeks: dict[tuple[int, int], list[date]] = {}
    current = start_date
    while current <= end_date:
        wk = _iso_week_key(current)
        iso_weeks.setdefault(wk, []).append(current)
        current += timedelta(days=1)

    payment_daily_by_date: dict[date, bool] = {}
    for date_str in payment_daily_covered_dates:
        parsed = date.fromisoformat(date_str)
        payment_daily_by_date[parsed] = True

    weekly_availability: list[dict[str, Any]] = []
    for wk_key in sorted(iso_weeks):
        wk_dates = iso_weeks[wk_key]
        wk_start = wk_dates[0]
        wk_end = wk_dates[-1]

        wk_business_dates = {d for d in wk_dates if d in business_daily_dates}
        wk_ad_dates = {d for d in wk_dates if d in ad_daily_dates}
        wk_business_all = {d for d in wk_dates if d in business_all_covered}
        wk_ad_all = {d for d in wk_dates if d in ad_all_covered}

        wk_payment_daily_dates = {d for d in wk_dates if payment_daily_by_date.get(d)}
        wk_payment_period_covered = any(
            p['period_start_date'] <= wk_start and p['period_end_date'] >= wk_end
            for p in payment_periods
        )
        wk_payment_covered = len(wk_payment_daily_dates) == len(wk_dates) or wk_payment_period_covered

        wk_can_calculate = len(wk_business_all) > 0 or len(wk_ad_all) > 0
        is_partial_daily = len(wk_business_dates) < len(wk_dates) or len(wk_ad_dates) < len(wk_dates)

        weekly_availability.append({
            'iso_year': wk_key[0],
            'iso_week': wk_key[1],
            'week_start_date': wk_start.isoformat(),
            'week_end_date': wk_end.isoformat(),
            'total_days': len(wk_dates),
            'business_report_available_days': len(wk_business_dates),
            'ad_report_available_days': len(wk_ad_dates),
            'business_periodic_covered': len(wk_business_all) > len(wk_business_dates),
            'ad_periodic_covered': len(wk_ad_all) > len(wk_ad_dates),
            'payment_covered': wk_payment_covered,
            'can_calculate': wk_can_calculate,
            'is_partial': is_partial_daily and not wk_payment_covered,
            'business_missing_dates': [d.isoformat() for d in sorted(set(wk_dates) - wk_business_dates)],
            'ad_missing_dates': [d.isoformat() for d in sorted(set(wk_dates) - wk_ad_dates)],
        })

    has_minimum_data = any(wk['can_calculate'] for wk in weekly_availability)

    return {
        'business_report_missing': [d.isoformat() for d in business_missing],
        'ad_report_missing': [d.isoformat() for d in ad_missing],
        'inventory_missing': [d.isoformat() for d in inventory_missing],
        'business_period_info': business_period_info,
        'ad_period_info': ad_period_info,
        'business_periodic_only_missing': [d.isoformat() for d in business_periodic_only],
        'ad_periodic_only_missing': [d.isoformat() for d in ad_periodic_only],
        'payment_periods_overlapping': [
            {
                'period_start_date': p['period_start_date'],
                'period_end_date': p['period_end_date'],
                'source_id': p['source_id'],
            }
            for p in payment_periods
        ],
        'payment_full_period_covered': payment_full_period_covered,
        'payment_daily_covered_dates': payment_daily_covered_dates,
        'has_minimum_data': has_minimum_data,
        'weekly_availability': weekly_availability,
    }