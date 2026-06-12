"""Product calculation data availability checks."""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from sqlalchemy import select, and_, or_
from sqlalchemy.orm import Session

from app.models import AnalysisSourceFile, AdUploadFile, AdUploadPromotedProductRow
from app.services.report_type_service import AD_PRODUCT_REPORT
from app.utils.country import normalize_country as _normalize_country
from app.utils.constants import PERIODIC_REPORT_TYPES

# 手动核算 C 表广告数据时，CLAUDE.md 明确要求按 scope_status='included_product'
# 过滤（行级粒度）。excluded_store_level / excluded_unmapped 行不能算入。
AD_INCLUDED_PRODUCT_SCOPE = 'included_product'


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

    def _ad_daily_dates() -> set[date]:
        """Get dates covered by daily ad reports from C table (AdUploadFile).

        仅当存在至少一行 `scope_status='included_product'` 时，该日期才算"被覆盖"，
        与 CLAUDE.md 对 AdUploadPromotedProductRow 的过滤要求保持一致。
        """
        rows = db.execute(
            select(AdUploadFile.period_end_date)
            .join(
                AdUploadPromotedProductRow,
                AdUploadPromotedProductRow.source_file_id == AdUploadFile.id,
            )
            .where(
                AdUploadFile.project_id == project_id,
                AdUploadFile.report_type == 'ad_promoted_product_report',
                AdUploadFile.country == normalized_country,
                AdUploadFile.is_current.is_(True),
                AdUploadFile.period_start_date == AdUploadFile.period_end_date,
                AdUploadFile.period_end_date >= start_date,
                AdUploadFile.period_end_date <= end_date,
                AdUploadPromotedProductRow.scope_status == AD_INCLUDED_PRODUCT_SCOPE,
            )
        ).scalars().all()
        return {r for r in rows if r is not None}

    def _ad_period_covered_dates() -> list[dict[str, Any]]:
        """Get periodic ad coverage info from C table (AdUploadFile).

        与 `_ad_daily_dates` 一致，按行级 `scope_status='included_product'` 过滤。
        """
        rows = db.execute(
            select(
                AdUploadFile.period_start_date,
                AdUploadFile.period_end_date,
                AdUploadFile.id,
            )
            .join(
                AdUploadPromotedProductRow,
                AdUploadPromotedProductRow.source_file_id == AdUploadFile.id,
            )
            .where(
                AdUploadFile.project_id == project_id,
                AdUploadFile.report_type == 'ad_promoted_product_report',
                AdUploadFile.country == normalized_country,
                AdUploadFile.is_current.is_(True),
                AdUploadFile.period_start_date < AdUploadFile.period_end_date,
                AdUploadFile.period_start_date <= end_date,
                AdUploadFile.period_end_date >= start_date,
                AdUploadPromotedProductRow.scope_status == AD_INCLUDED_PRODUCT_SCOPE,
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

    def _daily_dates(report_type: str) -> set[date]:
        """Get dates covered by daily reports only (for missing check)."""
        if report_type == AD_PRODUCT_REPORT:
            return _ad_daily_dates()
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
        if report_type == AD_PRODUCT_REPORT:
            return _ad_period_covered_dates()
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
            AnalysisSourceFile.row_count_total,
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
        if r.report_date is not None and int(r.row_count_total or 0) > 0
    })
    payment_daily_empty_dates = sorted({
        r.report_date.isoformat()
        for r in daily_payment_rows
        if r.report_date is not None and int(r.row_count_total or 0) <= 0
    })

    payment_period_rows = db.execute(
        select(
            AnalysisSourceFile.period_start_date,
            AnalysisSourceFile.period_end_date,
            AnalysisSourceFile.id,
            AnalysisSourceFile.row_count_total,
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
        if int(r.row_count_total or 0) > 0
    ]
    payment_empty_periods = [
        {'period_start_date': r.period_start_date, 'period_end_date': r.period_end_date, 'source_id': int(r.id)}
        for r in payment_period_rows
        if int(r.row_count_total or 0) <= 0
    ]

    payment_period_covered_dates: set[date] = set()
    for row in payment_period_rows:
        if row.period_start_date is None or row.period_end_date is None:
            continue
        if int(row.row_count_total or 0) <= 0:
            continue
        cur = max(row.period_start_date, start_date)
        cur_end = min(row.period_end_date, end_date)
        while cur <= cur_end:
            payment_period_covered_dates.add(cur)
            cur += timedelta(days=1)

    payment_full_period_covered = all_dates <= payment_period_covered_dates
    payment_objective_empty_dates: set[date] = {
        date.fromisoformat(item) for item in payment_daily_empty_dates
    }
    for row in payment_empty_periods:
        period_start = row['period_start_date']
        period_end = row['period_end_date']
        if period_start is None or period_end is None:
            continue
        cur = max(period_start, start_date)
        cur_end = min(period_end, end_date)
        while cur <= cur_end:
            payment_objective_empty_dates.add(cur)
            cur += timedelta(days=1)

    def _iso_week_key(d: date) -> tuple[int, int]:
        return d.isocalendar()[0], d.isocalendar()[1]

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

    payment_real_covered_dates: set[date] = set(payment_daily_by_date.keys()) | payment_period_covered_dates

    weekly_availability: list[dict[str, Any]] = []
    for wk_key in sorted(iso_weeks):
        wk_dates = iso_weeks[wk_key]
        wk_start = wk_dates[0]
        wk_end = wk_dates[-1]

        wk_business_dates = {d for d in wk_dates if d in business_daily_dates}
        wk_ad_dates = {d for d in wk_dates if d in ad_daily_dates}
        wk_business_all = {d for d in wk_dates if d in business_all_covered}
        wk_ad_all = {d for d in wk_dates if d in ad_all_covered}

        wk_payment_objective_empty_dates = {
            d for d in wk_dates if d in payment_objective_empty_dates and d not in payment_real_covered_dates
        }
        wk_payment_missing_dates = [
            d.isoformat() for d in wk_dates
            if d not in payment_real_covered_dates and d not in payment_objective_empty_dates
        ]
        wk_payment_covered = not wk_payment_missing_dates

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
            'is_partial': is_partial_daily or not wk_payment_covered,
            'business_missing_dates': [d.isoformat() for d in sorted(set(wk_dates) - wk_business_dates)],
            'ad_missing_dates': [d.isoformat() for d in sorted(set(wk_dates) - wk_ad_dates)],
            'payment_objective_empty_dates': [d.isoformat() for d in sorted(wk_payment_objective_empty_dates)],
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
        'payment_objective_empty_dates': [d.isoformat() for d in sorted(payment_objective_empty_dates - payment_real_covered_dates)],
        'has_minimum_data': has_minimum_data,
        'weekly_availability': weekly_availability,
    }
