from __future__ import annotations

import threading
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
import re
from typing import Any
import warnings
from zoneinfo import ZoneInfo

import pandas as pd
from sqlalchemy import Select, and_, func, insert, or_, select, update as sa_update
from sqlalchemy.orm import Session

from app.tasks.scripts import product_analysis as product_analysis_script
from app.services.report_type_service import AD_PRODUCT_REPORT, legacy_report_types_for, normalize_report_type
from app.services import exchange_rate_service
from app.models import (
    AnalysisAdProductRow,
    AnalysisBusinessRow,
    AnalysisPT1Calculation,
    AnalysisPTSKUDetail,
    AnalysisPaymentRow,
    AnalysisSalesOrderRow,
    AnalysisSourceFile,
    InventorySnapshotRow,
    ProductCost,
    Project,
)

# Shared utilities — single source of truth (backend/app/shared/utils.py)
from app.shared.utils import (
    normalize_text as _normalize_text,
    normalize_identity as _normalize_identity,
    to_int as _to_int,
    to_decimal as _to_decimal,
    to_decimal_with_currency as _to_decimal_with_currency,
    sum_decimals as _sum_decimals,
    sha256_file as _sha256_file,
    project_slug as _project_slug,
    build_logical_filename as _build_logical_filename,
    build_storage_key as _build_storage_key,
    to_raw_row as _to_raw_row,
    parse_yyyy_mm_dd as _parse_yyyy_mm_dd,
)

# Shared parsers — single source of truth (backend/app/shared/parsers.py)
from app.shared.parsers import (
    SCOPE_INCLUDED,
    SCOPE_EXCLUDED_STORE,
    SCOPE_EXCLUDED_UNMAPPED,
    COUNTRY_TIMEZONE as _COUNTRY_TIMEZONE,
    COUNTRY_ALIASES as _COUNTRY_ALIASES,
    INVENTORY_PROJECT_MATCH_MIN_ROWS,
    INVENTORY_PROJECT_MATCH_MIN_RATIO,
    PT_TIMEZONE,
    normalize_country as _normalize_country,
    match_columns as _match_columns,
    classify_scope as _classify_scope,
    build_aging_status as _build_aging_status,
    is_counted_sales_status as _is_counted_sales_status,
    parse_transaction_at as _parse_transaction_at,
    read_excel_no_warning as _read_excel_no_warning,
    parse_business_rows as _parse_business_rows,
    parse_payment_rows as _parse_payment_rows,
    parse_ad_rows as _parse_ad_rows,
    parse_inventory_rows as _parse_inventory_rows,
    parse_sales_rows as _parse_sales_rows,
    validate_inventory_rows_against_project_mapping as _validate_inventory_rows_against_project_mapping,
)
from app.shared.recognition import _read_payment_report

# Shared persist helpers — single source of truth (backend/app/shared/persist_helpers.py)
from app.shared.persist_helpers import (
    PERIODIC_REPORT_TYPES,
    next_version as _next_version,
    replace_current_pointer as _replace_current_pointer,
    write_report_upload_log as _write_report_upload_log,
)

ALL_REPORT_TYPES = PERIODIC_REPORT_TYPES | {'inventory_report'}

_SQLITE_TABLES_READY = False
_SQLITE_TABLES_LOCK = threading.Lock()


def _read_excel_without_style_warning(path: Path) -> pd.DataFrame:
    return _read_excel_no_warning(path)


def _restore_original_filename(upload_file_id: str | None) -> str | None:
    value = (upload_file_id or '').strip()
    if not value:
        return None
    match = re.match(r'^[0-9a-f]{32}_(.+)$', value, re.IGNORECASE)
    if match:
        restored = match.group(1).strip()
        if restored:
            return restored
    return value


def ensure_tables(db: Session) -> None:
    global _SQLITE_TABLES_READY
    bind = db.get_bind()
    if bind.dialect.name != 'sqlite':
        return
    if _SQLITE_TABLES_READY:
        return

    with _SQLITE_TABLES_LOCK:
        if _SQLITE_TABLES_READY:
            return
        for table in (
            AnalysisSourceFile.__table__,
            AnalysisBusinessRow.__table__,
            AnalysisPaymentRow.__table__,
            AnalysisAdProductRow.__table__,
            InventorySnapshotRow.__table__,
            AnalysisSalesOrderRow.__table__,
            AnalysisPT1Calculation.__table__,
            AnalysisPTSKUDetail.__table__,
        ):
            table.create(bind=bind, checkfirst=True)
        _SQLITE_TABLES_READY = True


@dataclass
class SourcePersistOutcome:
    report_type: str
    source_id: int | None
    success: bool
    error_message: str | None


def persist_product_analysis_pt1_calculation(
    db: Session,
    *,
    project_name: str,
    country: str = 'US',
    report_start_date: str,
    report_end_date: str,
    pt1: dict[str, Any],
    result_file_path: str | None = None,
    calculation_version: int = 1,
) -> AnalysisPT1Calculation:
    ensure_tables(db)
    project = _get_project_by_name(db, project_name)
    normalized_country = _normalize_country(country)
    start_date = _parse_yyyy_mm_dd(report_start_date, 'report_start_date')
    end_date = _parse_yyyy_mm_dd(report_end_date, 'report_end_date')
    if start_date > end_date:
        raise ValueError('report_start_date cannot be greater than report_end_date')
    if not isinstance(pt1, dict):
        raise ValueError('pt1 must be a dict')

    summary_raw = pt1.get('summary')
    if not isinstance(summary_raw, dict):
        raise ValueError('pt1.summary must be a dict')

    details_raw = pt1.get('details')
    details_payload = _build_pt_sku_detail_rows(details_raw)

    row_count_raw = pt1.get('row_count')
    try:
        fallback_row_count = max(0, int(row_count_raw))
    except (TypeError, ValueError):
        fallback_row_count = 0
    row_count = len(details_payload) if details_payload else fallback_row_count

    version = _next_pt1_version(
        db,
        project_id=project.id,
        country=normalized_country,
        report_start_date=start_date,
        report_end_date=end_date,
    )
    now = datetime.now(UTC)
    db.execute(
        sa_update(AnalysisPT1Calculation)
        .where(
            AnalysisPT1Calculation.project_id == project.id,
            AnalysisPT1Calculation.country == normalized_country,
            AnalysisPT1Calculation.report_start_date == start_date,
            AnalysisPT1Calculation.report_end_date == end_date,
            AnalysisPT1Calculation.is_current.is_(True),
        )
        .values(
            is_current=False,
            superseded_at=now,
        )
    )

    row = AnalysisPT1Calculation(
        project_id=project.id,
        project_name=project.project_name,
        report_start_date=start_date,
        report_end_date=end_date,
        version=version,
        country=normalized_country,
        is_current=True,
        superseded_at=None,
        row_count=row_count,
        summary_row=_to_raw_row(summary_raw),
        result_file_path=(str(result_file_path).strip() if result_file_path else None),
        calculation_version=calculation_version,
        computed_at=now,
    )
    db.add(row)
    db.flush()
    if details_payload:
        for item in details_payload:
            item['pt1_calculation_id'] = row.id
            item['country'] = normalized_country
        db.execute(insert(AnalysisPTSKUDetail), details_payload)
    return row


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
        df_payment = _build_payment_df_from_sources(
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
    """
    Compute and persist PT1 for a single period.
    Finds the current business_report, ad_product_report, and payment_report source files
    for the given project/country/period, builds the overview, and writes analysis_pt1_calculation.
    """
    ensure_tables(db)
    project = db.get(Project, project_id)
    if project is None:
        raise ValueError('project not found')

    normalized_country = _normalize_country(country)

    # Find source files for this period
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
            f'Missing source files for period {period_start_date}–{period_end_date}: '
            f'{", ".join(missing)}'
        )

    business_source = source_map['business_report']
    ad_source = source_map[AD_PRODUCT_REPORT]
    payment_source = source_map['payment_report']

    # Build DataFrames
    report_year_month = period_end_date.strftime('%Y-%m')
    df_cost = _build_active_product_costs_df(
        db,
        project_name=project.project_name,
        country=normalized_country,
        year_month=report_year_month,
    )
    df_business = _build_business_df_from_source(db, source_id=int(business_source.id))
    df_ad = _build_ad_df_from_source(db, source_id=int(ad_source.id))
    df_payment = _build_payment_df_from_source(db, source_id=int(payment_source.id))

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


def persist_product_analysis_sources(
    db: Session,
    *,
    project_name: str,
    report_start_date: str,
    report_end_date: str,
    country: str = 'US',
    file_ids: dict[str, str],
    resolved_file_paths: dict[str, str],
    created_by: str | None = None,
) -> list[SourcePersistOutcome]:
    ensure_tables(db)
    if not isinstance(file_ids, dict) or not isinstance(resolved_file_paths, dict):
        raise ValueError('file_ids and resolved_file_paths are required')

    project = _get_project_by_name(db, project_name)
    start_date = _parse_yyyy_mm_dd(report_start_date, 'report_start_date')
    end_date = _parse_yyyy_mm_dd(report_end_date, 'report_end_date')
    if start_date > end_date:
        raise ValueError('report_start_date cannot be greater than report_end_date')

    normalized_country = _normalize_country(country)
    known_skus, known_asins = _load_project_product_mapping(db, project.project_name, normalized_country)
    outcomes: list[SourcePersistOutcome] = []
    ordered_types = ['business_report', 'payment_report', AD_PRODUCT_REPORT, 'inventory_report']

    for report_type in ordered_types:
        file_id = _lookup_report_mapping_value(file_ids, report_type)
        file_path = _lookup_report_mapping_value(resolved_file_paths, report_type)
        if not file_id and not file_path:
            if report_type == 'inventory_report':
                continue
            outcomes.append(
                SourcePersistOutcome(
                    report_type=report_type,
                    source_id=None,
                    success=False,
                    error_message=f'missing file for {report_type}',
                )
            )
            continue

        outcome = _persist_one_source_file(
            db,
            project=project,
            report_type=report_type,
            country=normalized_country,
            report_date=None,
            period_start_date=start_date if report_type in PERIODIC_REPORT_TYPES else None,
            period_end_date=end_date if report_type in PERIODIC_REPORT_TYPES else None,
            upload_file_id=file_id or Path(file_path).name,
            upload_file_path=file_path or file_id,
            known_skus=known_skus,
            known_asins=known_asins,
            created_by=created_by,
        )
        outcomes.append(outcome)
        db.commit()

    return outcomes


def persist_single_date_report_sources(
    db: Session,
    *,
    project_name: str,
    report_date: str,
    country: str = 'US',
    file_ids: dict[str, str],
    resolved_file_paths: dict[str, str],
    created_by: str | None = None,
) -> list[SourcePersistOutcome]:
    ensure_tables(db)
    if not isinstance(file_ids, dict) or not isinstance(resolved_file_paths, dict):
        raise ValueError('file_ids and resolved_file_paths are required')

    project = _get_project_by_name(db, project_name)
    target_date = _parse_yyyy_mm_dd(report_date, 'report_date')
    normalized_country = _normalize_country(country)
    known_skus, known_asins = _load_project_product_mapping(db, project.project_name, normalized_country)
    outcomes: list[SourcePersistOutcome] = []
    for report_type in ('sales_report', AD_PRODUCT_REPORT):
        file_id = _lookup_report_mapping_value(file_ids, report_type)
        file_path = _lookup_report_mapping_value(resolved_file_paths, report_type)
        if not file_id and not file_path:
            outcomes.append(
                SourcePersistOutcome(
                    report_type=report_type,
                    source_id=None,
                    success=False,
                    error_message=f'missing file for {report_type}',
                )
            )
            continue

        if report_type == 'sales_report':
            outcome = _persist_one_source_file(
                db,
                project=project,
                report_type=report_type,
                country=normalized_country,
                report_date=target_date,
                period_start_date=target_date,
                period_end_date=target_date,
                upload_file_id=file_id or Path(file_path).name,
                upload_file_path=file_path or file_id,
                known_skus=known_skus,
                known_asins=known_asins,
                created_by=created_by,
                sales_count_as_of_date=target_date,
            )
        else:
            outcome = _persist_one_source_file(
                db,
                project=project,
                report_type=report_type,
                country=normalized_country,
                report_date=target_date,
                period_start_date=target_date,
                period_end_date=target_date,
                upload_file_id=file_id or Path(file_path).name,
                upload_file_path=file_path or file_id,
                known_skus=known_skus,
                known_asins=known_asins,
                created_by=created_by,
            )
        outcomes.append(outcome)
        db.commit()

    inventory_file_id = str(file_ids.get('inventory_report') or '').strip()
    inventory_file_path = str(resolved_file_paths.get('inventory_report') or '').strip()
    if not inventory_file_id and not inventory_file_path:
        outcomes.append(
            SourcePersistOutcome(
                report_type='inventory_report',
                source_id=None,
                success=False,
                error_message='missing file for inventory_report',
            )
        )
        return outcomes

    outcomes.append(
        _persist_one_source_file(
            db,
            project=project,
            report_type='inventory_report',
            country=normalized_country,
            report_date=None,
            period_start_date=None,
            period_end_date=None,
            upload_file_id=inventory_file_id or Path(inventory_file_path).name,
            upload_file_path=inventory_file_path or inventory_file_id,
            known_skus=known_skus,
            known_asins=known_asins,
            created_by=created_by,
        )
    )
    db.commit()

    return outcomes


def persist_single_analysis_source(
    db: Session,
    *,
    project_name: str,
    report_type: str,
    country: str = 'US',
    upload_file_id: str,
    upload_file_path: str,
    report_date: str | None = None,
    report_start_date: str | None = None,
    report_end_date: str | None = None,
    created_by: str | None = None,
) -> SourcePersistOutcome:
    ensure_tables(db)
    report_type = normalize_report_type(report_type)
    project = _get_project_by_name(db, project_name)
    normalized_country = _normalize_country(country)
    known_skus, known_asins = _load_project_product_mapping(db, project.project_name, normalized_country)

    normalized_report_date = _parse_yyyy_mm_dd(report_date, 'report_date') if report_date else None
    start_date = _parse_yyyy_mm_dd(report_start_date, 'report_start_date') if report_start_date else None
    end_date = _parse_yyyy_mm_dd(report_end_date, 'report_end_date') if report_end_date else None
    if report_type != 'inventory_report':
        if start_date is None or end_date is None:
            raise ValueError('report_start_date and report_end_date are required')
        if start_date > end_date:
            raise ValueError('report_start_date cannot be greater than report_end_date')
    if report_type in {'business_report', AD_PRODUCT_REPORT}:
        if normalized_report_date is None:
            if start_date is None or end_date is None:
                raise ValueError('report_date is required')
            if start_date != end_date:
                raise ValueError(f'{report_type} requires a single-day period')
            normalized_report_date = start_date
        if start_date is not None and normalized_report_date != start_date:
            raise ValueError(f'{report_type} report_date must equal report_start_date')
        if end_date is not None and normalized_report_date != end_date:
            raise ValueError(f'{report_type} report_date must equal report_end_date')

    outcome = _persist_one_source_file(
        db,
        project=project,
        report_type=report_type,
        country=normalized_country,
        report_date=normalized_report_date,
        period_start_date=start_date,
        period_end_date=end_date,
        upload_file_id=upload_file_id,
        upload_file_path=upload_file_path,
        known_skus=known_skus,
        known_asins=known_asins,
        created_by=created_by,
    )
    db.commit()
    return outcome


def persist_sales_report_by_purchase_date(
    db: Session,
    *,
    project_name: str,
    upload_file_id: str,
    upload_file_path: str,
    country: str = 'US',
    created_by: str | None = None,
) -> dict[str, Any]:
    ensure_tables(db)
    project = _get_project_by_name(db, project_name)
    normalized_country = _normalize_country(country)
    path = Path(upload_file_path)
    if not path.exists() or not path.is_file():
        raise FileNotFoundError(f'File not found: {upload_file_path}')

    rows, total, _ = _parse_sales_rows(path, 0, None, country=normalized_country)
    grouped_rows: dict[date, list[dict[str, Any]]] = {}
    for row in rows:
        purchase_date_pt = row.get('purchase_date_pt')
        if not isinstance(purchase_date_pt, date):
            continue
        grouped_rows.setdefault(purchase_date_pt, []).append(row)

    if not grouped_rows:
        # 无有效购买日期行 —— 写入标记记录，确保 RPA 状态正确显示"已上传（无数据）"
        target_date = date.today()
        version = _next_version(
            db,
            project_id=project.id,
            report_type='sales_report',
            country=normalized_country,
            period_start_date=target_date,
            period_end_date=target_date,
        )
        now = datetime.now(UTC)
        file_size_bytes = path.stat().st_size
        file_sha256 = _sha256_file(path)
        extension = (path.suffix or Path(upload_file_id).suffix or '').lower()
        project_slug = _project_slug(project.project_name)
        source = AnalysisSourceFile(
            project_id=project.id,
            report_type='sales_report',
            country=normalized_country,
            report_date=target_date,
            period_start_date=target_date,
            period_end_date=target_date,
            snapshot_at=None,
            version=version,
            is_current=False,
            superseded_at=None,
            upload_file_id=upload_file_id,
            upload_file_path=upload_file_path,
            original_filename=_restore_original_filename(upload_file_id),
            stored_filename=upload_file_id,
            logical_filename=_build_logical_filename(
                project_slug=project_slug,
                report_type='sales_report',
                period_start_date=target_date,
                period_end_date=target_date,
                snapshot_at=now,
                version=version,
                extension=extension,
            ),
            storage_key=_build_storage_key(
                project_slug=project_slug,
                report_type='sales_report',
                period_start_date=target_date,
                period_end_date=target_date,
                snapshot_at=now,
                version=version,
                upload_file_id=upload_file_id,
            ),
            file_size_bytes=file_size_bytes,
            file_sha256=file_sha256,
            ingestion_status='success',
            ingestion_error=None,
            row_count_total=0,
            row_count_included=0,
            created_by=(created_by or '').strip()[:255] or None,
        )
        db.add(source)
        db.commit()
        _write_report_upload_log(
            db, project.id, normalized_country, 'sales_report',
            source_file_id=source.id,
            has_real_data=False,
            row_count=0,
            original_filename=_restore_original_filename(upload_file_id),
        )
        db.commit()
        return {
            'success': True,
            'latest_source_id': source.id,
            'report_start_date': target_date.isoformat(),
            'report_end_date': target_date.isoformat(),
            'report_dates': [target_date.isoformat()],
            'days_persisted': 1,
            'row_count_total': 0,
            'message': '销售报表无有效购买日期记录，已记录空上传',
        }

    file_size_bytes = path.stat().st_size
    file_sha256 = _sha256_file(path)
    extension = (path.suffix or Path(upload_file_id).suffix or '').lower()
    project_slug = _project_slug(project.project_name)

    latest_source_id: int | None = None
    latest_report_date: date | None = None

    for report_date in sorted(grouped_rows):
        version = _next_version(
            db,
            project_id=project.id,
            report_type='sales_report',
            country=normalized_country,
            period_start_date=report_date,
            period_end_date=report_date,
        )
        now = datetime.now(UTC)
        source = AnalysisSourceFile(
            project_id=project.id,
            report_type='sales_report',
            country=normalized_country,
            report_date=report_date,
            period_start_date=report_date,
            period_end_date=report_date,
            snapshot_at=None,
            version=version,
            is_current=False,
            superseded_at=None,
            upload_file_id=upload_file_id,
            upload_file_path=upload_file_path,
            original_filename=_restore_original_filename(upload_file_id),
            stored_filename=upload_file_id,
            logical_filename=_build_logical_filename(
                project_slug=project_slug,
                report_type='sales_report',
                period_start_date=report_date,
                period_end_date=report_date,
                snapshot_at=now,
                version=version,
                extension=extension,
            ),
            storage_key=_build_storage_key(
                project_slug=project_slug,
                report_type='sales_report',
                period_start_date=report_date,
                period_end_date=report_date,
                snapshot_at=now,
                version=version,
                upload_file_id=upload_file_id,
            ),
            file_size_bytes=file_size_bytes,
            file_sha256=file_sha256,
            ingestion_status='running',
            ingestion_error=None,
            row_count_total=0,
            row_count_included=0,
            created_by=(created_by or '').strip()[:255] or None,
        )
        db.add(source)
        db.flush()

        daily_rows = grouped_rows[report_date]
        included = 0
        payloads: list[dict[str, Any]] = []
        for row in daily_rows:
            item = dict(row)
            item['source_file_id'] = source.id
            if item.get('is_counted_sales'):
                included += 1
            payloads.append(item)
        if payloads:
            db.execute(insert(AnalysisSalesOrderRow), payloads)

        source.row_count_total = len(payloads)
        source.row_count_included = included
        source.ingestion_status = 'success'
        source.ingestion_error = None

        _replace_current_pointer(db, source)
        source.is_current = True
        source.superseded_at = None
        db.flush()

        latest_source_id = source.id
        latest_report_date = report_date

    db.commit()
    _write_report_upload_log(
        db, project.id, normalized_country, 'sales_report',
        source_file_id=latest_source_id,
        has_real_data=total > 0,
        row_count=total,
        original_filename=_restore_original_filename(upload_file_id),
    )
    db.commit()
    report_dates = sorted(grouped_rows)
    return {
        'success': True,
        'latest_source_id': latest_source_id,
        'report_start_date': report_dates[0].isoformat(),
        'report_end_date': report_dates[-1].isoformat(),
        'report_dates': [item.isoformat() for item in report_dates],
        'days_persisted': len(report_dates),
        'row_count_total': total,
        'message': (
            f'销售报表已按购买日期自动拆分为 {len(report_dates)} 个报表日期，'
            f'范围 {report_dates[0].isoformat()} ~ {report_dates[-1].isoformat()}'
        ),
    }
def list_sources(
    db: Session,
    *,
    project_id: int | None = None,
    report_type: str | None = None,
    period_start_date: date | None = None,
    period_end_date: date | None = None,
    current_only: bool = True,
) -> list[AnalysisSourceFile]:
    ensure_tables(db)
    stmt: Select = select(AnalysisSourceFile).order_by(AnalysisSourceFile.created_at.desc(), AnalysisSourceFile.id.desc())
    if current_only:
        stmt = stmt.where(AnalysisSourceFile.is_current.is_(True))
    if project_id is not None:
        stmt = stmt.where(AnalysisSourceFile.project_id == project_id)
    if report_type:
        normalized = normalize_report_type(report_type)
        if normalized not in ALL_REPORT_TYPES:
            raise ValueError(f'Unsupported report_type: {report_type}')
        stmt = stmt.where(AnalysisSourceFile.report_type == normalized)
    if period_start_date is not None:
        stmt = stmt.where(
            (
                (AnalysisSourceFile.period_end_date.is_not(None))
                & (AnalysisSourceFile.period_end_date >= period_start_date)
            )
            | ((AnalysisSourceFile.snapshot_at.is_not(None)) & (AnalysisSourceFile.snapshot_at >= datetime.combine(period_start_date, datetime.min.time(), tzinfo=UTC)))
        )
    if period_end_date is not None:
        stmt = stmt.where(
            (
                (AnalysisSourceFile.period_start_date.is_not(None))
                & (AnalysisSourceFile.period_start_date <= period_end_date)
            )
            | ((AnalysisSourceFile.snapshot_at.is_not(None)) & (AnalysisSourceFile.snapshot_at <= datetime.combine(period_end_date, datetime.max.time(), tzinfo=UTC)))
        )
    return list(db.execute(stmt).scalars().all())


def get_source_or_none(db: Session, source_id: int) -> AnalysisSourceFile | None:
    ensure_tables(db)
    return db.get(AnalysisSourceFile, source_id)


def get_source_rows(
    db: Session,
    *,
    source_id: int,
    page: int,
    page_size: int,
    include_excluded: bool = False,
) -> tuple[AnalysisSourceFile, list[dict[str, Any]], bool]:
    ensure_tables(db)
    source = db.get(AnalysisSourceFile, source_id)
    if source is None:
        raise ValueError('Source file not found')
    if page < 1 or page_size < 1:
        raise ValueError('page and page_size must be >= 1')

    model = _get_row_model(source.report_type)
    stmt: Select = select(model).where(model.source_file_id == source_id).order_by(model.source_row_no.asc())
    if source.report_type in {'payment_report', AD_PRODUCT_REPORT} and not include_excluded:
        stmt = stmt.where(model.scope_status == SCOPE_INCLUDED)

    rows = db.execute(stmt.offset((page - 1) * page_size).limit(page_size + 1)).scalars().all()
    has_next = len(rows) > page_size
    rows = rows[:page_size]
    payload = [_serialize_row(source.report_type, row) for row in rows]
    return source, payload, has_next


def get_current_inventory_snapshot(
    db: Session,
    *,
    project_id: int,
    country: str = 'US',
    start_date: date | None = None,
    end_date: date | None = None,
) -> tuple[AnalysisSourceFile, list[dict[str, Any]]] | None:
    ensure_tables(db)
    normalized_country = _normalize_country(country)
    stmt = select(AnalysisSourceFile).where(
        AnalysisSourceFile.project_id == project_id,
        AnalysisSourceFile.report_type == 'inventory_report',
        AnalysisSourceFile.country == normalized_country,
    )
    if start_date is None and end_date is None:
        stmt = stmt.where(AnalysisSourceFile.is_current.is_(True))
    else:
        if start_date is not None:
            stmt = stmt.where(
                (
                    AnalysisSourceFile.report_date.is_not(None)
                    & (AnalysisSourceFile.report_date >= start_date)
                )
                | (
                    AnalysisSourceFile.report_date.is_(None)
                    & AnalysisSourceFile.snapshot_at.is_not(None)
                    & (
                        AnalysisSourceFile.snapshot_at
                        >= datetime.combine(start_date, datetime.min.time(), tzinfo=UTC)
                    )
                )
            )
        if end_date is not None:
            stmt = stmt.where(
                (
                    AnalysisSourceFile.report_date.is_not(None)
                    & (AnalysisSourceFile.report_date <= end_date)
                )
                | (
                    AnalysisSourceFile.report_date.is_(None)
                    & AnalysisSourceFile.snapshot_at.is_not(None)
                    & (
                        AnalysisSourceFile.snapshot_at
                        <= datetime.combine(end_date, datetime.max.time(), tzinfo=UTC)
                    )
                )
            )
    source = db.execute(
        stmt.order_by(
            AnalysisSourceFile.report_date.desc(),
            AnalysisSourceFile.snapshot_at.desc(),
            AnalysisSourceFile.version.desc(),
            AnalysisSourceFile.id.desc(),
        ).limit(1)
    ).scalars().first()
    if source is None:
        return None
    rows = db.execute(
        select(InventorySnapshotRow)
        .where(InventorySnapshotRow.source_file_id == source.id)
        .order_by(InventorySnapshotRow.source_row_no.asc())
    ).scalars().all()
    return source, [_serialize_row('inventory_report', row) for row in rows]


def _lookup_report_mapping_value(mapping: dict[str, str], report_type: str) -> str:
    normalized = normalize_report_type(report_type)
    value = str(mapping.get(normalized) or '').strip()
    if value:
        return value
    for legacy_type in legacy_report_types_for(normalized):
        value = str(mapping.get(legacy_type) or '').strip()
        if value:
            return value
    return ''


def _persist_one_source_file(
    db: Session,
    *,
    project: Project,
    report_type: str,
    country: str,
    report_date: date | None,
    period_start_date: date | None,
    period_end_date: date | None,
    upload_file_id: str,
    upload_file_path: str,
    known_skus: set[str],
    known_asins: set[str],
    created_by: str | None,
    sales_count_as_of_date: date | None = None,
) -> SourcePersistOutcome:
    report_type = normalize_report_type(report_type)
    if report_type not in ALL_REPORT_TYPES:
        raise ValueError(f'Unsupported report_type: {report_type}')

    now = datetime.now(UTC)
    path = Path(upload_file_path)
    extension = (path.suffix or Path(upload_file_id).suffix or '').lower()
    version = _next_version(
        db,
        project_id=project.id,
        report_type=report_type,
        country=country,
        period_start_date=period_start_date,
        period_end_date=period_end_date,
    )
    project_slug = _project_slug(project.project_name)
    logical_filename = _build_logical_filename(
        project_slug=project_slug,
        report_type=report_type,
        period_start_date=period_start_date,
        period_end_date=period_end_date,
        snapshot_at=now,
        version=version,
        extension=extension,
    )
    storage_key = _build_storage_key(
        project_slug=project_slug,
        report_type=report_type,
        period_start_date=period_start_date,
        period_end_date=period_end_date,
        snapshot_at=now,
        version=version,
        upload_file_id=upload_file_id,
    )

    source = AnalysisSourceFile(
        project_id=project.id,
        report_type=report_type,
        country=country,
        report_date=report_date,
        period_start_date=period_start_date,
        period_end_date=period_end_date,
        snapshot_at=datetime.combine(report_date, datetime.min.time())
        if report_type == 'inventory_report' and report_date
        else None,
        version=version,
        is_current=False,
        superseded_at=None,
        upload_file_id=upload_file_id,
        upload_file_path=upload_file_path,
        original_filename=_restore_original_filename(upload_file_id),
        stored_filename=upload_file_id,
        logical_filename=logical_filename,
        storage_key=storage_key,
        file_size_bytes=None,
        file_sha256=None,
        ingestion_status='running',
        ingestion_error=None,
        row_count_total=0,
        row_count_included=0,
        created_by=(created_by or '').strip()[:255] or None,
    )
    db.add(source)
    db.flush()

    try:
        if not path.exists() or not path.is_file():
            raise FileNotFoundError(f'File not found: {upload_file_path}')

        source.file_size_bytes = path.stat().st_size
        source.file_sha256 = _sha256_file(path)

        if report_type == 'business_report':
            rows, total, included = _parse_business_rows(path, source.id)
            if rows:
                db.execute(insert(AnalysisBusinessRow), rows)
        elif report_type == 'payment_report':
            df, _, _, _ = _read_payment_report(path)
            rows, total, included = _parse_payment_rows(df, source.id, known_skus, known_asins)
            if rows:
                db.execute(insert(AnalysisPaymentRow), rows)
        elif report_type == AD_PRODUCT_REPORT:
            rows, total, included = _parse_ad_rows(path, source.id, known_skus, known_asins)
            if rows:
                db.execute(insert(AnalysisAdProductRow), rows)
        elif report_type == 'sales_report':
            rows, total, included = _parse_sales_rows(
                path,
                source.id,
                sales_count_as_of_date,
                country=country,
            )
            if rows:
                db.execute(insert(AnalysisSalesOrderRow), rows)
        else:
            rows, total, included = _parse_inventory_rows(path, source.id)
            _validate_inventory_rows_against_project_mapping(
                rows,
                project_name=project.project_name,
                country=country,
                known_skus=known_skus,
                known_asins=known_asins,
            )
            if rows:
                db.execute(insert(InventorySnapshotRow), rows)

        source.row_count_total = total
        source.row_count_included = included
        source.ingestion_status = 'success'
        source.ingestion_error = None

        _replace_current_pointer(db, source)
        source.is_current = True
        source.superseded_at = None
        db.flush()
        return SourcePersistOutcome(report_type=report_type, source_id=source.id, success=True, error_message=None)
    except Exception as exc:  # noqa: BLE001
        source.ingestion_status = 'failed'
        source.ingestion_error = str(exc)[:4000]
        source.is_current = False
        source.superseded_at = None
        db.flush()
        return SourcePersistOutcome(report_type=report_type, source_id=source.id, success=False, error_message=str(exc))
def _next_pt1_version(
    db: Session,
    *,
    project_id: int,
    country: str,
    report_start_date: date,
    report_end_date: date,
) -> int:
    stmt = (
        select(func.max(AnalysisPT1Calculation.version))
        .where(
            AnalysisPT1Calculation.project_id == project_id,
            AnalysisPT1Calculation.country == country,
            AnalysisPT1Calculation.report_start_date == report_start_date,
            AnalysisPT1Calculation.report_end_date == report_end_date,
        )
    )
    value = db.execute(stmt).scalar_one_or_none()
    return int(value or 0) + 1


def _build_active_product_costs_df(db: Session, *, project_name: str, country: str, year_month: str) -> pd.DataFrame:
    rows = db.execute(
        select(ProductCost).where(
            ProductCost.project_name == project_name,
            ProductCost.is_active.is_(True),
            ProductCost.country == country,
        )
    ).scalars().all()
    if not rows:
        raise ValueError(f'No active product_costs found for project_name={project_name}, country={country}')

    data: list[dict[str, object]] = []
    for row in rows:
        fob_cost, _ = exchange_rate_service.convert_rmb_to_target_currency(
            row.fob_unit_cost or 0,
            country=country,
            year_month=year_month,
            db=db,
        )
        first_leg_cost, _ = exchange_rate_service.convert_rmb_to_target_currency(
            row.first_leg_cost_rmb or 0,
            country=country,
            year_month=year_month,
            db=db,
        )
        data.append(
            {
                'SKU': row.sku,
                'ASIN': row.asin,
                '头程单价': float(first_leg_cost),
                'FOB单价': float(fob_cost),
            }
        )

    return pd.DataFrame(data)


def _list_recomputable_weekly_period_sources(
    db: Session,
    *,
    project_id: int,
    country: str,
    start_date: date | None,
    end_date: date | None,
    current_only: bool,
) -> list[dict[str, Any]]:
    stmt = select(AnalysisSourceFile).where(
        AnalysisSourceFile.project_id == project_id,
        AnalysisSourceFile.report_type.in_(('business_report', AD_PRODUCT_REPORT, 'payment_report')),
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
        business_rows = [daily_sources['business_report'].get(day) for day in week_dates]
        ad_rows = [daily_sources[AD_PRODUCT_REPORT].get(day) for day in week_dates]

        available_business = [row for row in business_rows if row is not None]
        available_ad = [row for row in ad_rows if row is not None]
        if not available_business and not available_ad:
            continue

        business_missing_dates = [d.isoformat() for d, row in zip(week_dates, business_rows) if row is None]
        ad_missing_dates = [d.isoformat() for d, row in zip(week_dates, ad_rows) if row is None]

        payment_source_ids: list[int] = []
        payment_covered = False
        payment_type = 'none'

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

        key = (week_dates[0], week_dates[-1])
        entry: dict[str, Any] = {
            'report_start_date': week_dates[0],
            'report_end_date': week_dates[-1],
            'business_report_source_ids': [int(row.id) for row in available_business],
            'ad_report_source_ids': [int(row.id) for row in available_ad],
            'payment_report_source_ids': payment_source_ids,
            'is_partial': bool(business_missing_dates or ad_missing_dates or not payment_covered),
            'completeness': {
                'total_days': len(week_dates),
                'available_business_days': len(available_business),
                'available_ad_days': len(available_ad),
                'business_missing_dates': business_missing_dates,
                'ad_missing_dates': ad_missing_dates,
                'payment_covered': payment_covered,
                'payment_type': payment_type,
                'payment_missing': not payment_covered,
                'payment_missing_dates': payment_missing_dates_list if payment_type in ('partial', 'none') else [],
            },
        }

        periods_by_key[key] = entry

    # Clean up orphaned single-day entries that leaked from Phase 1 (§1341–1356).
    # When an ISO week is skipped because some days lack business/ad data,
    # the single-day source-file periods pre-loaded into periods_by_key persist
    # and would surface as standalone "weeks" with start_date == end_date.
    periods_by_key = {
        key: value
        for key, value in periods_by_key.items()
        if key[0] != key[1]
    }

    return [periods_by_key[key] for key in sorted(periods_by_key)]


def check_product_calculation_data_availability(
    db: Session,
    *,
    project_id: int,
    country: str,
    start_date: date,
    end_date: date,
) -> dict[str, Any]:
    normalized_country = _normalize_country(country)

    # Generate full set of calendar dates in the range
    all_dates: set[date] = set()
    d = start_date
    while d <= end_date:
        all_dates.add(d)
        d += timedelta(days=1)

    # Helper: get existing report dates for a given report_type (show all versions, not just current)
    def _existing_dates(report_type: str) -> set[date]:
        rows = db.execute(
            select(AnalysisSourceFile.report_date).where(
                AnalysisSourceFile.project_id == project_id,
                AnalysisSourceFile.report_type == report_type,
                AnalysisSourceFile.country == normalized_country,
                AnalysisSourceFile.report_date >= start_date,
                AnalysisSourceFile.report_date <= end_date,
            )
        ).scalars().all()
        return {r for r in rows if r is not None}

    business_dates = _existing_dates('business_report')
    ad_dates = _existing_dates(AD_PRODUCT_REPORT)
    inventory_dates = _existing_dates('inventory_report')

    business_missing = sorted(all_dates - business_dates)
    ad_missing = sorted(all_dates - ad_dates)
    inventory_missing = sorted(all_dates - inventory_dates)

    # Payment report: support both historical single-day rows and period rows.
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

        wk_business_dates = {d for d in wk_dates if d in business_dates}
        wk_ad_dates = {d for d in wk_dates if d in ad_dates}

        wk_payment_daily_dates = {d for d in wk_dates if payment_daily_by_date.get(d)}
        wk_payment_period_covered = any(
            p['period_start_date'] <= wk_start and p['period_end_date'] >= wk_end
            for p in payment_periods
        )
        wk_payment_covered = len(wk_payment_daily_dates) == len(wk_dates) or wk_payment_period_covered

        wk_can_calculate = len(wk_business_dates) > 0 or len(wk_ad_dates) > 0

        weekly_availability.append({
            'iso_year': wk_key[0],
            'iso_week': wk_key[1],
            'week_start_date': wk_start.isoformat(),
            'week_end_date': wk_end.isoformat(),
            'total_days': len(wk_dates),
            'business_report_available_days': len(wk_business_dates),
            'ad_report_available_days': len(wk_ad_dates),
            'payment_covered': wk_payment_covered,
            'can_calculate': wk_can_calculate,
            'is_partial': len(wk_business_dates) < len(wk_dates) or len(wk_ad_dates) < len(wk_dates) or not wk_payment_covered,
            'business_missing_dates': [d.isoformat() for d in sorted(set(wk_dates) - wk_business_dates)],
            'ad_missing_dates': [d.isoformat() for d in sorted(set(wk_dates) - wk_ad_dates)],
        })

    has_minimum_data = any(wk['can_calculate'] for wk in weekly_availability)

    return {
        'business_report_missing': [d.isoformat() for d in business_missing],
        'ad_report_missing': [d.isoformat() for d in ad_missing],
        'inventory_missing': [d.isoformat() for d in inventory_missing],
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


def _is_full_iso_week(start_date: date, end_date: date) -> bool:
    """Check if the date range is a complete ISO week (Monday to Sunday)."""
    if (end_date - start_date).days != 6:
        return False
    if start_date.weekday() != 0:
        return False
    if end_date.weekday() != 6:
        return False
    iso_start = start_date.isocalendar()
    iso_end = end_date.isocalendar()
    return iso_start[0] == iso_end[0] and iso_start[1] == iso_end[1]


def _is_single_full_week(start_date: date, end_date: date) -> bool:
    """
    Returns True if and only if the range is exactly ONE complete ISO week (Mon-Sun).
    Does NOT match multiple consecutive complete weeks.

    Use this for deciding whether to persist to PT1 — only persist when the user
    explicitly selects a single complete week.
    """
    if (end_date - start_date).days != 6:
        return False
    if start_date.weekday() != 0:  # Monday
        return False
    if end_date.weekday() != 6:    # Sunday
        return False
    iso_start = start_date.isocalendar()
    iso_end = end_date.isocalendar()
    return iso_start[0] == iso_end[0] and iso_start[1] == iso_end[1]


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
    # Only persist to PT1 if the user-selected range is exactly one complete ISO week.
    # Multi-week or partial-week selections: merge all sources, return ONE consolidated period.
    should_persist = (
        start_date is not None
        and end_date is not None
        and _is_single_full_week(start_date, end_date)
    )

    if should_persist:
        # Single ISO week: persist each period individually (existing behaviour)
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
            df_payment = _build_payment_df_from_sources(
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
        # Cross-week or partial-week: merge ALL sources into ONE consolidated period
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
        df_payment = _build_payment_df_from_sources(
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


def _build_business_df_from_source(db: Session, *, source_id: int) -> pd.DataFrame:
    _BUSINESS_COLUMNS = ['ASIN', '页面浏览量', '总销量', '总访客', '总销售额']
    rows = db.execute(
        select(AnalysisBusinessRow).where(AnalysisBusinessRow.source_file_id == source_id).order_by(AnalysisBusinessRow.source_row_no.asc())
    ).scalars().all()
    if not rows:
        return pd.DataFrame(columns=_BUSINESS_COLUMNS)
    return pd.DataFrame(
        [
            {
                'ASIN': row.asin or '',
                '页面浏览量': int(row.page_views or 0),
                '总销量': int(row.units_ordered or 0),
                '总访客': int(row.sessions or 0),
                '总销售额': float(row.ordered_sales_amount or 0),
            }
            for row in rows
        ]
    )


def _build_business_df_from_sources(db: Session, *, source_ids: list[int]) -> pd.DataFrame:
    if not source_ids:
        return pd.DataFrame(columns=['ASIN', '页面浏览量', '总销量', '总访客', '总销售额'])
    frames = [_build_business_df_from_source(db, source_id=source_id) for source_id in source_ids]
    non_empty = [frame for frame in frames if not frame.empty]
    if not non_empty:
        return pd.DataFrame(columns=['ASIN', '页面浏览量', '总销量', '总访客', '总销售额'])
    combined = pd.concat(non_empty, ignore_index=True)
    return combined.groupby('ASIN', as_index=False).sum(numeric_only=True)


def _build_ad_df_from_source(db: Session, *, source_id: int) -> pd.DataFrame:
    rows = db.execute(
        select(AnalysisAdProductRow)
        .where(AnalysisAdProductRow.source_file_id == source_id)
        .order_by(AnalysisAdProductRow.source_row_no.asc())
    ).scalars().all()
    return pd.DataFrame(
        [
            {
                'SKU': row.sku or '',
                '广告展示量': int(row.impressions or 0),
                '广告点击量': int(row.clicks or 0),
                '广告花费': float(row.spend or 0),
                '广告销售额': float(row.sales_7d or 0),
                '广告订单量': int(row.orders_7d or 0),
            }
            for row in rows
        ]
    ).groupby('SKU', as_index=False).sum() if rows else pd.DataFrame(
        columns=['SKU', '广告展示量', '广告点击量', '广告花费', '广告销售额', '广告订单量']
    )


def _build_ad_df_from_sources(db: Session, *, source_ids: list[int]) -> pd.DataFrame:
    if not source_ids:
        return pd.DataFrame(columns=['SKU', '广告展示量', '广告点击量', '广告花费', '广告销售额', '广告订单量'])
    frames = [_build_ad_df_from_source(db, source_id=source_id) for source_id in source_ids]
    non_empty = [frame for frame in frames if not frame.empty]
    if not non_empty:
        return pd.DataFrame(columns=['SKU', '广告展示量', '广告点击量', '广告花费', '广告销售额', '广告订单量'])
    combined = pd.concat(non_empty, ignore_index=True)
    return combined.groupby('SKU', as_index=False).sum(numeric_only=True)


def _build_payment_df_from_source(db: Session, *, source_id: int) -> pd.DataFrame:
    _PAYMENT_COLUMNS = ['type', 'sku', 'quantity', 'product sales', 'shipping credits', 'promotional rebates', 'other', 'selling fees', 'fba fees']
    rows = db.execute(
        select(AnalysisPaymentRow).where(AnalysisPaymentRow.source_file_id == source_id).order_by(AnalysisPaymentRow.source_row_no.asc())
    ).scalars().all()
    if not rows:
        return pd.DataFrame(columns=_PAYMENT_COLUMNS)
    return pd.DataFrame(
        [
            {
                'type': row.transaction_type,
                'sku': row.sku or '',
                'quantity': int(row.quantity or 0),
                'product sales': float(row.product_sales or 0),
                'shipping credits': float(row.shipping_credits or 0),
                'promotional rebates': float(row.promotional_rebates or 0),
                'other': float(row.other_amount or 0),
                'selling fees': float(row.selling_fees or 0),
                'fba fees': float(row.fba_fees or 0),
            }
            for row in rows
        ]
    )


def _build_payment_df_from_sources(db: Session, *, source_ids: list[int]) -> pd.DataFrame:
    _PAYMENT_COLUMNS = ['type', 'sku', 'quantity', 'product sales', 'shipping credits', 'promotional rebates', 'other', 'selling fees', 'fba fees']
    if not source_ids:
        return pd.DataFrame(columns=_PAYMENT_COLUMNS)
    frames = [_build_payment_df_from_source(db, source_id=source_id) for source_id in source_ids]
    non_empty = [frame for frame in frames if not frame.empty]
    if not non_empty:
        return pd.DataFrame(columns=_PAYMENT_COLUMNS)
    return pd.concat(non_empty, ignore_index=True)


def _build_pt_sku_detail_rows(details: Any) -> list[dict[str, Any]]:
    if not isinstance(details, list):
        return []

    payloads: list[dict[str, Any]] = []
    for index, raw in enumerate(details):
        if not isinstance(raw, dict):
            continue
        sku = _normalize_text(raw.get('SKU'))
        if sku == '汇总':
            continue
        payloads.append(
            {
                'pt1_calculation_id': 0,
                'source_row_no': index + 1,
                'report_date': _normalize_text(raw.get('日期')),
                'sku': sku,
                'asin': _normalize_text(raw.get('ASIN')),
                'total_units': _to_int(raw.get('总销量')),
                'total_sales_amount': _to_decimal(raw.get('总销售额')),
                'page_views': _to_int(raw.get('页面浏览量')),
                'total_visitors': _to_int(raw.get('总访客')),
                'ad_impressions': _to_int(raw.get('广告展示量')),
                'ad_clicks': _to_int(raw.get('广告点击量')),
                'ad_orders': _to_int(raw.get('广告订单量')),
                'ad_spend': _to_decimal(raw.get('广告花费')),
                'ad_sales_amount': _to_decimal(raw.get('广告销售额')),
                'actual_sales_amount': _to_decimal(raw.get('实际销售额')),
                'actual_sales_units': _to_int(raw.get('实际销售量')),
                'actual_refund_amount': _to_decimal(raw.get('实际退款额')),
                'actual_refund_units': _to_int(raw.get('实际退款量')),
                'profit_amount': _to_decimal(raw.get('利润')),
                'profit_rate': _to_decimal(raw.get('利润率')),
                'raw_row': _to_raw_row(raw),
            }
        )
    return payloads


def _load_project_product_mapping(db: Session, project_name: str, country: str = 'US') -> tuple[set[str], set[str]]:
    rows = db.execute(
        select(ProductCost.sku, ProductCost.asin).where(
            ProductCost.project_name == project_name,
            ProductCost.is_active.is_(True),
            ProductCost.country == _normalize_country(country),
        )
    ).all()
    known_skus = {_normalize_identity(value) for value, _ in rows if _normalize_identity(value)}
    known_asins = {_normalize_identity(value) for _, value in rows if _normalize_identity(value)}
    return known_skus, known_asins


def _get_project_by_name(db: Session, project_name: str) -> Project:
    normalized = (project_name or '').strip()
    if not normalized:
        raise ValueError('project_name is required')
    project = db.execute(select(Project).where(Project.project_name == normalized)).scalars().first()
    if project is None:
        raise ValueError(f'Project not found: {normalized}')
    return project


# _parse_yyyy_mm_dd is imported from shared (via alias at top of file)


# _to_raw_row is imported from shared (via alias at top of file)


def _get_row_model(report_type: str):
    if report_type == 'business_report':
        return AnalysisBusinessRow
    if report_type == 'payment_report':
        return AnalysisPaymentRow
    if report_type == AD_PRODUCT_REPORT:
        return AnalysisAdProductRow
    if report_type == 'inventory_report':
        return InventorySnapshotRow
    if report_type == 'sales_report':
        return AnalysisSalesOrderRow
    raise ValueError(f'Unsupported report_type: {report_type}')


def _serialize_row(report_type: str, row: Any) -> dict[str, Any]:
    if report_type == 'business_report':
        return {
            'source_row_no': row.source_row_no,
            'asin': row.asin,
            'page_views': row.page_views,
            'units_ordered': row.units_ordered,
            'sessions': row.sessions,
            'ordered_sales_amount': float(row.ordered_sales_amount or 0),
            'raw_row': row.raw_row,
        }
    if report_type == 'payment_report':
        return {
            'source_row_no': row.source_row_no,
            'transaction_at': row.transaction_at,
            'transaction_type': row.transaction_type,
            'order_id': row.order_id,
            'sku': row.sku,
            'asin': row.asin,
            'quantity': row.quantity,
            'product_sales': float(row.product_sales or 0),
            'shipping_credits': float(row.shipping_credits or 0),
            'promotional_rebates': float(row.promotional_rebates or 0),
            'other_amount': float(row.other_amount or 0),
            'selling_fees': float(row.selling_fees or 0),
            'fba_fees': float(row.fba_fees or 0),
            'total_amount': float(row.total_amount or 0),
            'scope_status': row.scope_status,
            'scope_reason': row.scope_reason,
            'raw_row': row.raw_row,
        }
    if report_type == AD_PRODUCT_REPORT:
        return {
            'source_row_no': row.source_row_no,
            'sku': row.sku,
            'asin': row.asin,
            'impressions': row.impressions,
            'clicks': row.clicks,
            'spend': float(row.spend or 0),
            'sales_7d': float(row.sales_7d or 0),
            'orders_7d': row.orders_7d,
            'scope_status': row.scope_status,
            'scope_reason': row.scope_reason,
            'raw_row': row.raw_row,
        }
    if report_type == 'inventory_report':
        return {
            'source_row_no': row.source_row_no,
            'sku': row.sku,
            'asin': row.asin,
            'available_qty': row.available_qty,
            'age_0_90_qty': row.age_0_90_qty,
            'age_91_180_qty': row.age_91_180_qty,
            'age_181_270_qty': row.age_181_270_qty,
            'age_271_365_qty': row.age_271_365_qty,
            'age_365_plus_qty': row.age_365_plus_qty,
            'recommended_action': row.recommended_action,
            'stock_status': row.stock_status,
            'aging_status': row.aging_status,
            'raw_row': row.raw_row,
        }
    if report_type == 'sales_report':
        return {
            'source_row_no': row.source_row_no,
            'amazon_order_id': row.amazon_order_id,
            'purchase_at_utc': row.purchase_at_utc,
            'purchase_at_pt': row.purchase_at_pt,
            'purchase_date_pt': row.purchase_date_pt,
            'order_status': row.order_status,
            'sku': row.sku,
            'asin': row.asin,
            'quantity': row.quantity,
            'item_price': float(row.item_price or 0),
            'shipping_price': float(row.shipping_price or 0),
            'currency': row.currency,
            'is_counted_sales': row.is_counted_sales,
            'status_rule_version': row.status_rule_version,
            'raw_row': row.raw_row,
        }
    raise ValueError(f'Unsupported report_type: {report_type}')
