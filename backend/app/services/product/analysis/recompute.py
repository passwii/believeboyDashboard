"""Product analysis recompute functions."""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import select, and_, or_
from sqlalchemy.orm import Session

from app.models import AnalysisSourceFile, AnalysisPT1Calculation, Project
from app.services.product._internal import _is_single_full_week
from app.services.product.analysis.costs import _build_active_product_costs_df
from app.services.product.analysis.period_sources import _list_history_weekly_period_sources
from app.services.product.persistence import (
    ensure_tables,
    persist_product_analysis_pt1_calculation,
)
from app.services.product.business import _build_business_df_from_source, _build_business_df_from_sources
from app.services.product.ad import _build_ad_df_from_source, _build_ad_df_from_sources
from app.services.payment import build_df_from_source, build_df_from_sources
from app.tasks.scripts import product_analysis as product_analysis_script
from app.services.report_type_service import AD_PRODUCT_REPORT
from app.utils.country import normalize_country as _normalize_country


def recompute_weekly_product_analysis_from_history(
    db: Session,
    *,
    project_id: int,
    country: str = 'US',
    start_date: date | None = None,
    end_date: date | None = None,
    current_only: bool = True,
) -> dict[str, Any]:
    ensure_tables(db)
    project = db.get(Project, project_id)
    if project is None:
        raise ValueError('project not found')

    normalized_country = _normalize_country(country)
    period_sources = _list_history_weekly_period_sources(
        db,
        project_id=project_id,
        country=normalized_country,
        start_date=start_date,
        end_date=end_date,
        current_only=current_only,
    )

    periods: list[dict[str, Any]] = []
    for item in period_sources:
        report_start_date = item['report_start_date']
        report_end_date = item['report_end_date']
        report_year_month = report_end_date.strftime('%Y-%m')
        df_cost = _build_active_product_costs_df(
            db,
            project_name=project.project_name,
            country=normalized_country,
            year_month=report_year_month,
        )
        df_business = _build_business_df_from_sources(
            db,
            source_ids=item['business_report_source_ids'],
        )
        df_ad = _build_ad_df_from_sources(
            db,
            source_ids=item['ad_report_source_ids'],
        )
        df_payment = build_df_from_sources(
            db,
            source_ids=item['payment_report_source_ids'],
        )
        report_date = product_analysis_script._format_report_date(
            report_start_date.isoformat(),
            report_end_date.isoformat(),
        )
        df_overview = product_analysis_script._build_overview(
            project.project_name,
            report_date,
            df_cost,
            df_business,
            df_ad,
            product_analysis_script._build_payment_aggregate(df_payment),
        )
        df_overview = product_analysis_script._append_summary_row(df_overview, report_date)
        pt1 = product_analysis_script._build_pt1_payload(df_overview)
        if item.get('completeness'):
            pt1['summary']['_completeness'] = item['completeness']
            pt1['summary']['_is_partial'] = item.get('is_partial', False)
        pt1_row = persist_product_analysis_pt1_calculation(
            db,
            project_name=project.project_name,
            country=normalized_country,
            report_start_date=report_start_date.isoformat(),
            report_end_date=report_end_date.isoformat(),
            pt1=pt1,
            result_file_path=None,
            calculation_version=1,
        )
        period_entry: dict[str, Any] = {
            'pt1_id': int(pt1_row.id),
            'version': int(pt1_row.version),
            'report_start_date': report_start_date.isoformat(),
            'report_end_date': report_end_date.isoformat(),
            'row_count': int(pt1_row.row_count or 0),
            'business_report_source_id': int(item['business_report_source_ids'][0]),
            'ad_report_source_id': int(item['ad_report_source_ids'][0]),
            'payment_report_source_id': int(item['payment_report_source_ids'][0]) if item['payment_report_source_ids'] else None,
            'is_partial': item.get('is_partial', False),
            'completeness': item.get('completeness', {}),
        }
        periods.append(period_entry)

    return {
        'project_id': int(project.id),
        'project_name': project.project_name,
        'country': normalized_country,
        'recomputed': len(periods),
        'skipped': 0,
        'periods': periods,
    }


def recompute_pt1_for_period(
    db: Session,
    *,
    project_id: int,
    country: str = 'US',
    period_start_date: date,
    period_end_date: date,
) -> dict[str, Any]:
    ensure_tables(db)
    project = db.get(Project, project_id)
    if project is None:
        raise ValueError('project not found')

    normalized_country = _normalize_country(country)

    stmt = select(AnalysisSourceFile).where(
        AnalysisSourceFile.project_id == project_id,
        AnalysisSourceFile.report_type.in_(
            ('business_report', AD_PRODUCT_REPORT, 'payment_report')
        ),
        AnalysisSourceFile.country == normalized_country,
        AnalysisSourceFile.is_current.is_(True),
        AnalysisSourceFile.period_start_date == period_start_date,
        AnalysisSourceFile.period_end_date == period_end_date,
    )
    rows = db.execute(stmt.order_by(AnalysisSourceFile.report_type.asc())).scalars().all()

    source_map: dict[str, AnalysisSourceFile] = {}
    for row in rows:
        source_map[row.report_type] = row

    missing = {'business_report', AD_PRODUCT_REPORT, 'payment_report'} - set(source_map.keys())
    if missing:
        raise ValueError(
            f'Missing source files for period {period_start_date}-{period_end_date}: '
            f'{", ".join(missing)}'
        )

    business_source = source_map['business_report']
    ad_source = source_map[AD_PRODUCT_REPORT]
    payment_source = source_map['payment_report']

    report_year_month = period_end_date.strftime('%Y-%m')
    df_cost = _build_active_product_costs_df(
        db,
        project_name=project.project_name,
        country=normalized_country,
        year_month=report_year_month,
    )
    df_business = _build_business_df_from_source(db, source_id=int(business_source.id))
    df_ad = _build_ad_df_from_source(db, source_id=int(ad_source.id))
    df_payment = build_df_from_source(db, source_id=int(payment_source.id))

    report_date_str = product_analysis_script._format_report_date(
        period_start_date.isoformat(),
        period_end_date.isoformat(),
    )
    df_overview = product_analysis_script._build_overview(
        project.project_name,
        report_date_str,
        df_cost,
        df_business,
        df_ad,
        product_analysis_script._build_payment_aggregate(df_payment),
    )
    df_overview = product_analysis_script._append_summary_row(df_overview, report_date_str)
    pt1_payload = product_analysis_script._build_pt1_payload(df_overview)

    pt1_row = persist_product_analysis_pt1_calculation(
        db,
        project_name=project.project_name,
        country=normalized_country,
        report_start_date=period_start_date.isoformat(),
        report_end_date=period_end_date.isoformat(),
        pt1=pt1_payload,
        result_file_path=None,
        calculation_version=1,
    )

    return {
        'pt1_id': int(pt1_row.id),
        'version': int(pt1_row.version),
        'report_start_date': period_start_date.isoformat(),
        'report_end_date': period_end_date.isoformat(),
        'row_count': int(pt1_row.row_count or 0),
        'business_report_source_id': int(business_source.id),
        'ad_report_source_id': int(ad_source.id),
        'payment_report_source_id': int(payment_source.id),
    }


def run_product_calculation_from_history(
    db: Session,
    *,
    project_id: int,
    country: str = 'US',
    start_date: date | None = None,
    end_date: date | None = None,
    current_only: bool = True,
) -> dict[str, Any]:
    project = db.get(Project, project_id)
    if project is None:
        raise ValueError('project not found')

    normalized_country = _normalize_country(country)
    period_sources = _list_history_weekly_period_sources(
        db,
        project_id=project_id,
        country=normalized_country,
        start_date=start_date,
        end_date=end_date,
        current_only=current_only,
    )
    should_persist = (
        start_date is not None
        and end_date is not None
        and _is_single_full_week(start_date, end_date)
    )

    if should_persist:
        periods: list[dict[str, Any]] = []
        for item in period_sources:
            week_start = item['report_start_date']
            week_end = item['report_end_date']
            year_month = week_end.strftime('%Y-%m')

            df_cost = _build_active_product_costs_df(
                db,
                project_name=project.project_name,
                country=normalized_country,
                year_month=year_month,
            )
            df_business = _build_business_df_from_sources(
                db,
                source_ids=item['business_report_source_ids'],
            )
            df_ad = _build_ad_df_from_sources(
                db,
                source_ids=item['ad_report_source_ids'],
            )
            df_payment = build_df_from_sources(
                db,
                source_ids=item['payment_report_source_ids'],
            )
            report_date_str = product_analysis_script._format_report_date(
                week_start.isoformat(),
                week_end.isoformat(),
            )
            df_overview = product_analysis_script._build_overview(
                project.project_name,
                report_date_str,
                df_cost,
                df_business,
                df_ad,
                product_analysis_script._build_payment_aggregate(df_payment),
            )
            df_overview = product_analysis_script._append_summary_row(df_overview, report_date_str)
            pt1 = product_analysis_script._build_pt1_payload(df_overview)
            if item.get('completeness'):
                pt1['summary']['_completeness'] = item['completeness']
                pt1['summary']['_is_partial'] = item.get('is_partial', False)
            pt1_row = persist_product_analysis_pt1_calculation(
                db,
                project_name=project.project_name,
                country=normalized_country,
                report_start_date=week_start.isoformat(),
                report_end_date=week_end.isoformat(),
                pt1=pt1,
                result_file_path=None,
                calculation_version=1,
            )
            periods.append({
                'pt1_id': int(pt1_row.id),
                'version': int(pt1_row.version),
                'report_start_date': week_start.isoformat(),
                'report_end_date': week_end.isoformat(),
                'summary': pt1['summary'],
                'details': pt1['details'],
                'is_partial': item.get('is_partial', False),
                'completeness': item.get('completeness', {}),
                'persisted': True,
            })
    elif start_date is not None and end_date is not None and period_sources:
        all_business_ids: list[int] = []
        all_ad_ids: list[int] = []
        all_payment_ids: list[int] = []
        is_partial = False
        merged_completeness: dict[str, Any] = {}
        for item in period_sources:
            all_business_ids.extend(item['business_report_source_ids'])
            all_ad_ids.extend(item['ad_report_source_ids'])
            all_payment_ids.extend(item['payment_report_source_ids'])
            if item.get('is_partial'):
                is_partial = True
            if not merged_completeness and item.get('completeness'):
                merged_completeness = item['completeness']

        year_month = end_date.strftime('%Y-%m')
        df_cost = _build_active_product_costs_df(
            db,
            project_name=project.project_name,
            country=normalized_country,
            year_month=year_month,
        )
        df_business = _build_business_df_from_sources(
            db,
            source_ids=all_business_ids,
        )
        df_ad = _build_ad_df_from_sources(
            db,
            source_ids=all_ad_ids,
        )
        df_payment = build_df_from_sources(
            db,
            source_ids=all_payment_ids,
        )
        report_date_str = product_analysis_script._format_report_date(
            start_date.isoformat(),
            end_date.isoformat(),
        )
        df_overview = product_analysis_script._build_overview(
            project.project_name,
            report_date_str,
            df_cost,
            df_business,
            df_ad,
            product_analysis_script._build_payment_aggregate(df_payment),
        )
        df_overview = product_analysis_script._append_summary_row(df_overview, report_date_str)
        pt1 = product_analysis_script._build_pt1_payload(df_overview)
        if merged_completeness:
            pt1['summary']['_completeness'] = merged_completeness
            pt1['summary']['_is_partial'] = is_partial
        periods = [{
            'pt1_id': None,
            'version': None,
            'report_start_date': start_date.isoformat(),
            'report_end_date': end_date.isoformat(),
            'summary': pt1['summary'],
            'details': pt1['details'],
            'is_partial': is_partial,
            'completeness': merged_completeness,
            'persisted': False,
        }]
    else:
        periods = []

    return {
        'project_id': int(project.id),
        'project_name': project.project_name,
        'country': normalized_country,
        'total_periods': len(periods),
        'periods': periods,
    }