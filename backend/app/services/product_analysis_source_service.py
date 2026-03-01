from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal, InvalidOperation
import hashlib
from pathlib import Path
import re
from threading import Lock
from typing import Any
from zoneinfo import ZoneInfo

import pandas as pd
from slugify import slugify
from sqlalchemy import Select, func, insert, select, update as sa_update
from sqlalchemy.orm import Session

from app.models import (
    AnalysisAdRow,
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

PERIODIC_REPORT_TYPES = {'business_report', 'payment_report', 'ad_report', 'sales_report'}
ALL_REPORT_TYPES = PERIODIC_REPORT_TYPES | {'inventory_report'}
SCOPE_INCLUDED = 'included_product'
SCOPE_EXCLUDED_STORE = 'excluded_store_level'
SCOPE_EXCLUDED_UNMAPPED = 'excluded_unmapped'

_SQLITE_TABLES_READY = False
_SQLITE_TABLES_LOCK = Lock()
PT_TIMEZONE = ZoneInfo('America/Los_Angeles')


@dataclass
class SourcePersistOutcome:
    report_type: str
    source_id: int | None
    success: bool
    error_message: str | None


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
            AnalysisAdRow.__table__,
            InventorySnapshotRow.__table__,
            AnalysisSalesOrderRow.__table__,
            AnalysisPT1Calculation.__table__,
            AnalysisPTSKUDetail.__table__,
        ):
            table.create(bind=bind, checkfirst=True)
        _SQLITE_TABLES_READY = True


def persist_product_analysis_pt1_calculation(
    db: Session,
    *,
    project_name: str,
    report_start_date: str,
    report_end_date: str,
    pt1: dict[str, Any],
    result_file_path: str | None = None,
    calculation_version: int = 1,
) -> AnalysisPT1Calculation:
    ensure_tables(db)
    project = _get_project_by_name(db, project_name)
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
        report_start_date=start_date,
        report_end_date=end_date,
    )
    now = datetime.now(UTC)
    db.execute(
        sa_update(AnalysisPT1Calculation)
        .where(
            AnalysisPT1Calculation.project_id == project.id,
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
        db.execute(insert(AnalysisPTSKUDetail), details_payload)
    return row


def list_weekly_product_analysis_from_details(
    db: Session,
    *,
    project_id: int,
    start_date: date | None = None,
    end_date: date | None = None,
    current_only: bool = True,
) -> list[dict[str, Any]]:
    ensure_tables(db)
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


def persist_product_analysis_sources(
    db: Session,
    *,
    project_name: str,
    report_start_date: str,
    report_end_date: str,
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

    known_skus, known_asins = _load_project_product_mapping(db, project.project_name)
    outcomes: list[SourcePersistOutcome] = []
    ordered_types = ['business_report', 'payment_report', 'ad_report', 'inventory_report']

    for report_type in ordered_types:
        file_id = str(file_ids.get(report_type) or '').strip()
        file_path = str(resolved_file_paths.get(report_type) or '').strip()
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


def persist_daily_report_sources(
    db: Session,
    *,
    project_name: str,
    report_date: str,
    file_ids: dict[str, str],
    resolved_file_paths: dict[str, str],
    created_by: str | None = None,
) -> list[SourcePersistOutcome]:
    ensure_tables(db)
    if not isinstance(file_ids, dict) or not isinstance(resolved_file_paths, dict):
        raise ValueError('file_ids and resolved_file_paths are required')

    project = _get_project_by_name(db, project_name)
    target_date = _parse_yyyy_mm_dd(report_date, 'report_date')
    known_skus, known_asins = _load_project_product_mapping(db, project.project_name)
    outcomes: list[SourcePersistOutcome] = []
    ordered_types = ['sales_report', 'ad_report', 'inventory_report']

    for report_type in ordered_types:
        file_id = str(file_ids.get(report_type) or '').strip()
        file_path = str(resolved_file_paths.get(report_type) or '').strip()
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

        outcome = _persist_one_source_file(
            db,
            project=project,
            report_type=report_type,
            period_start_date=target_date if report_type in PERIODIC_REPORT_TYPES else None,
            period_end_date=target_date if report_type in PERIODIC_REPORT_TYPES else None,
            upload_file_id=file_id or Path(file_path).name,
            upload_file_path=file_path or file_id,
            known_skus=known_skus,
            known_asins=known_asins,
            created_by=created_by,
            sales_count_as_of_date=target_date if report_type == 'sales_report' else None,
        )
        outcomes.append(outcome)
        db.commit()

    return outcomes


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
        normalized = report_type.strip()
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
    if source.report_type in {'payment_report', 'ad_report'} and not include_excluded:
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
) -> tuple[AnalysisSourceFile, list[dict[str, Any]]] | None:
    ensure_tables(db)
    source = db.execute(
        select(AnalysisSourceFile)
        .where(
            AnalysisSourceFile.project_id == project_id,
            AnalysisSourceFile.report_type == 'inventory_report',
            AnalysisSourceFile.is_current.is_(True),
        )
        .order_by(AnalysisSourceFile.id.desc())
        .limit(1)
    ).scalars().first()
    if source is None:
        return None
    rows = db.execute(
        select(InventorySnapshotRow)
        .where(InventorySnapshotRow.source_file_id == source.id)
        .order_by(InventorySnapshotRow.source_row_no.asc())
    ).scalars().all()
    return source, [_serialize_row('inventory_report', row) for row in rows]


def _persist_one_source_file(
    db: Session,
    *,
    project: Project,
    report_type: str,
    period_start_date: date | None,
    period_end_date: date | None,
    upload_file_id: str,
    upload_file_path: str,
    known_skus: set[str],
    known_asins: set[str],
    created_by: str | None,
    sales_count_as_of_date: date | None = None,
) -> SourcePersistOutcome:
    if report_type not in ALL_REPORT_TYPES:
        raise ValueError(f'Unsupported report_type: {report_type}')

    now = datetime.now(UTC)
    path = Path(upload_file_path)
    extension = (path.suffix or Path(upload_file_id).suffix or '').lower()
    version = _next_version(
        db,
        project_id=project.id,
        report_type=report_type,
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
        period_start_date=period_start_date,
        period_end_date=period_end_date,
        snapshot_at=now if report_type == 'inventory_report' else None,
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
            rows, total, included = _parse_payment_rows(path, source.id, known_skus, known_asins)
            if rows:
                db.execute(insert(AnalysisPaymentRow), rows)
        elif report_type == 'ad_report':
            rows, total, included = _parse_ad_rows(path, source.id, known_skus, known_asins)
            if rows:
                db.execute(insert(AnalysisAdRow), rows)
        elif report_type == 'sales_report':
            rows, total, included = _parse_sales_rows(path, source.id, sales_count_as_of_date)
            if rows:
                db.execute(insert(AnalysisSalesOrderRow), rows)
        else:
            rows, total, included = _parse_inventory_rows(path, source.id)
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


def _replace_current_pointer(db: Session, source: AnalysisSourceFile) -> None:
    conditions = [
        AnalysisSourceFile.project_id == source.project_id,
        AnalysisSourceFile.report_type == source.report_type,
        AnalysisSourceFile.id != source.id,
        AnalysisSourceFile.is_current.is_(True),
    ]
    if source.report_type in PERIODIC_REPORT_TYPES:
        conditions.extend(
            [
                AnalysisSourceFile.period_start_date == source.period_start_date,
                AnalysisSourceFile.period_end_date == source.period_end_date,
            ]
        )
    db.execute(
        sa_update(AnalysisSourceFile)
        .where(*conditions)
        .values(
            is_current=False,
            superseded_at=datetime.now(UTC),
        )
    )


def _next_version(
    db: Session,
    *,
    project_id: int,
    report_type: str,
    period_start_date: date | None,
    period_end_date: date | None,
) -> int:
    stmt = select(func.max(AnalysisSourceFile.version)).where(
        AnalysisSourceFile.project_id == project_id,
        AnalysisSourceFile.report_type == report_type,
    )
    if report_type in PERIODIC_REPORT_TYPES:
        stmt = stmt.where(
            AnalysisSourceFile.period_start_date == period_start_date,
            AnalysisSourceFile.period_end_date == period_end_date,
        )
    value = db.execute(stmt).scalar_one_or_none()
    return int(value or 0) + 1


def _next_pt1_version(
    db: Session,
    *,
    project_id: int,
    report_start_date: date,
    report_end_date: date,
) -> int:
    stmt = (
        select(func.max(AnalysisPT1Calculation.version))
        .where(
            AnalysisPT1Calculation.project_id == project_id,
            AnalysisPT1Calculation.report_start_date == report_start_date,
            AnalysisPT1Calculation.report_end_date == report_end_date,
        )
    )
    value = db.execute(stmt).scalar_one_or_none()
    return int(value or 0) + 1


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


def _parse_business_rows(path: Path, source_file_id: int) -> tuple[list[dict[str, Any]], int, int]:
    df = pd.read_csv(path, encoding='utf-8-sig')
    df.columns = [str(col).strip() for col in df.columns]

    aliases = {
        'asin': ['（子）ASIN', '(子)ASIN', '子ASIN', 'ASIN'],
        'page_views': ['页面浏览量 - 总计', '页面浏览量-总计', 'Page Views - Total'],
        'units_ordered': ['已订购商品数量', 'Ordered Product Sales Units', 'Units Ordered'],
        'sessions': ['会话数 - 总计', '会话数-总计', 'Sessions - Total'],
        'ordered_sales_amount': ['已订购商品销售额', 'Ordered Product Sales', 'Ordered Product Sales Amount'],
    }
    mapped = _match_columns(df.columns, aliases, 'Business report')

    payloads: list[dict[str, Any]] = []
    for index, row in df.iterrows():
        amount = _to_decimal_with_currency(row.get(mapped['ordered_sales_amount']))
        payloads.append(
            {
                'source_file_id': source_file_id,
                'source_row_no': int(index) + 1,
                'asin': _normalize_text(row.get(mapped['asin'])),
                'page_views': _to_int(row.get(mapped['page_views'])),
                'units_ordered': _to_int(row.get(mapped['units_ordered'])),
                'sessions': _to_int(row.get(mapped['sessions'])),
                'ordered_sales_amount': amount,
                'raw_row': _to_raw_row(row.to_dict()),
            }
        )
    total = len(payloads)
    return payloads, total, total


def _parse_payment_rows(
    path: Path,
    source_file_id: int,
    known_skus: set[str],
    known_asins: set[str],
) -> tuple[list[dict[str, Any]], int, int]:
    df = pd.read_csv(path, encoding='utf-8-sig', thousands=',', skiprows=7)
    df.columns = [str(col).strip() for col in df.columns]

    required = {
        'type',
        'sku',
        'quantity',
        'product sales',
        'shipping credits',
        'promotional rebates',
        'other',
        'selling fees',
        'fba fees',
    }
    missing = [col for col in required if col not in df.columns]
    if missing:
        raise ValueError(f'Payment report missing required columns: {missing}')

    numeric_cols = [
        'quantity',
        'product sales',
        'shipping credits',
        'promotional rebates',
        'other',
        'selling fees',
        'fba fees',
    ]
    if 'total' in df.columns:
        numeric_cols.append('total')
    for col in numeric_cols:
        df[col] = pd.to_numeric(df[col], errors='coerce').fillna(0)

    asin_col = 'asin' if 'asin' in df.columns else ('ASIN' if 'ASIN' in df.columns else None)
    payloads: list[dict[str, Any]] = []
    included = 0

    for index, row in df.iterrows():
        sku = _normalize_text(row.get('sku'))
        asin = _normalize_text(row.get(asin_col)) if asin_col else None
        scope_status, scope_reason = _classify_scope(sku=sku, asin=asin, known_skus=known_skus, known_asins=known_asins)
        if scope_status == SCOPE_INCLUDED:
            included += 1

        total_amount = _to_decimal(row.get('total')) if 'total' in df.columns else _sum_decimals(
            row.get('product sales'),
            row.get('shipping credits'),
            row.get('promotional rebates'),
            row.get('other'),
            row.get('selling fees'),
            row.get('fba fees'),
        )
        payloads.append(
            {
                'source_file_id': source_file_id,
                'source_row_no': int(index) + 1,
                'transaction_at': _parse_transaction_at(row),
                'transaction_type': _normalize_text(row.get('type')) or 'UNKNOWN',
                'order_id': _normalize_text(row.get('order id') if 'order id' in df.columns else None),
                'sku': sku,
                'asin': asin,
                'quantity': _to_int(row.get('quantity')),
                'product_sales': _to_decimal(row.get('product sales')),
                'shipping_credits': _to_decimal(row.get('shipping credits')),
                'promotional_rebates': _to_decimal(row.get('promotional rebates')),
                'other_amount': _to_decimal(row.get('other')),
                'selling_fees': _to_decimal(row.get('selling fees')),
                'fba_fees': _to_decimal(row.get('fba fees')),
                'total_amount': total_amount,
                'scope_status': scope_status,
                'scope_reason': scope_reason,
                'raw_row': _to_raw_row(row.to_dict()),
            }
        )

    return payloads, len(payloads), included


def _parse_ad_rows(
    path: Path,
    source_file_id: int,
    known_skus: set[str],
    known_asins: set[str],
) -> tuple[list[dict[str, Any]], int, int]:
    df = pd.read_excel(path, engine='openpyxl')
    df.columns = [str(col).strip() for col in df.columns]

    required = ['广告SKU', '展示量', '点击量', '花费', '7天总销售额', '7天总销售量(#)']
    missing = [col for col in required if col not in df.columns]
    if missing:
        raise ValueError(f'Ad report missing required columns: {missing}')

    payloads: list[dict[str, Any]] = []
    included = 0
    asin_col = '广告ASIN' if '广告ASIN' in df.columns else ('ASIN' if 'ASIN' in df.columns else None)

    for index, row in df.iterrows():
        sku = _normalize_text(row.get('广告SKU'))
        asin = _normalize_text(row.get(asin_col)) if asin_col else None
        scope_status, scope_reason = _classify_scope(sku=sku, asin=asin, known_skus=known_skus, known_asins=known_asins)
        if scope_status == SCOPE_INCLUDED:
            included += 1
        payloads.append(
            {
                'source_file_id': source_file_id,
                'source_row_no': int(index) + 1,
                'sku': sku,
                'asin': asin,
                'impressions': _to_int(row.get('展示量')),
                'clicks': _to_int(row.get('点击量')),
                'spend': _to_decimal(row.get('花费')),
                'sales_7d': _to_decimal(row.get('7天总销售额')),
                'orders_7d': _to_int(row.get('7天总销售量(#)')),
                'scope_status': scope_status,
                'scope_reason': scope_reason,
                'raw_row': _to_raw_row(row.to_dict()),
            }
        )
    return payloads, len(payloads), included


def _parse_inventory_rows(path: Path, source_file_id: int) -> tuple[list[dict[str, Any]], int, int]:
    df = pd.read_csv(path, sep='\t', encoding='utf-8-sig')
    df.columns = [str(col).strip() for col in df.columns]
    keep = [
        'sku',
        'asin',
        'available',
        'inv-age-0-to-90-days',
        'inv-age-91-to-180-days',
        'inv-age-181-to-270-days',
        'inv-age-271-to-365-days',
        'inv-age-365-plus-days',
        'recommended-action',
    ]
    existing = [col for col in keep if col in df.columns]
    if not existing:
        raise ValueError('Inventory report missing required columns')

    payloads: list[dict[str, Any]] = []
    for index, row in df.iterrows():
        available_qty = _to_int(row.get('available'))
        age_0_90 = _to_int(row.get('inv-age-0-to-90-days'))
        age_91_180 = _to_int(row.get('inv-age-91-to-180-days'))
        age_181_270 = _to_int(row.get('inv-age-181-to-270-days'))
        age_271_365 = _to_int(row.get('inv-age-271-to-365-days'))
        age_365_plus = _to_int(row.get('inv-age-365-plus-days'))
        stock_status = 'out_of_stock' if available_qty <= 0 else 'in_stock'
        aging_status = _build_aging_status(
            age_91_180=age_91_180,
            age_181_270=age_181_270,
            age_271_365=age_271_365,
            age_365_plus=age_365_plus,
        )
        payloads.append(
            {
                'source_file_id': source_file_id,
                'source_row_no': int(index) + 1,
                'sku': _normalize_text(row.get('sku')),
                'asin': _normalize_text(row.get('asin')),
                'available_qty': available_qty,
                'age_0_90_qty': age_0_90,
                'age_91_180_qty': age_91_180,
                'age_181_270_qty': age_181_270,
                'age_271_365_qty': age_271_365,
                'age_365_plus_qty': age_365_plus,
                'recommended_action': _normalize_text(row.get('recommended-action')),
                'stock_status': stock_status,
                'aging_status': aging_status,
                'raw_row': _to_raw_row(row.to_dict()),
            }
        )
    total = len(payloads)
    return payloads, total, total


def _parse_sales_rows(
    path: Path,
    source_file_id: int,
    count_as_of_date_pt: date | None,
) -> tuple[list[dict[str, Any]], int, int]:
    df = pd.read_csv(path, sep='\t', encoding='utf-8-sig')
    df.columns = [str(col).strip() for col in df.columns]
    required = ['amazon-order-id', 'purchase-date', 'order-status', 'sku', 'asin', 'quantity', 'item-price']
    missing = [col for col in required if col not in df.columns]
    if missing:
        raise ValueError(f'Sales report missing required columns: {missing}')

    effective_as_of = count_as_of_date_pt or datetime.now(UTC).astimezone(PT_TIMEZONE).date()
    payloads: list[dict[str, Any]] = []
    included = 0

    for index, row in df.iterrows():
        order_id = _normalize_text(row.get('amazon-order-id'))
        parsed_utc = pd.to_datetime(row.get('purchase-date'), utc=True, errors='coerce')
        if order_id is None or pd.isna(parsed_utc):
            continue

        purchase_at_utc = parsed_utc.to_pydatetime()
        purchase_at_pt_aware = purchase_at_utc.astimezone(PT_TIMEZONE)
        purchase_at_pt = purchase_at_pt_aware.replace(tzinfo=None)
        purchase_date_pt = purchase_at_pt_aware.date()
        status_text = (_normalize_text(row.get('order-status')) or '').strip()
        is_counted = _is_counted_sales_status(status_text, purchase_date_pt, effective_as_of)
        if is_counted:
            included += 1

        payloads.append(
            {
                'source_file_id': source_file_id,
                'source_row_no': int(index) + 1,
                'amazon_order_id': order_id,
                'purchase_at_utc': purchase_at_utc,
                'purchase_at_pt': purchase_at_pt,
                'purchase_date_pt': purchase_date_pt,
                'order_status': status_text or 'UNKNOWN',
                'sku': _normalize_text(row.get('sku')),
                'asin': _normalize_text(row.get('asin')),
                'quantity': _to_int(row.get('quantity')),
                'item_price': _to_decimal(row.get('item-price')),
                'currency': _normalize_text(row.get('currency')),
                'is_counted_sales': is_counted,
                'status_rule_version': 1,
                'raw_row': _to_raw_row(row.to_dict()),
            }
        )
    return payloads, len(payloads), included


def _is_counted_sales_status(status: str, purchase_date_pt: date, as_of_date_pt: date) -> bool:
    normalized = status.strip().lower()
    if normalized in {'cancelled', 'canceled'}:
        return False
    age_days = (as_of_date_pt - purchase_date_pt).days
    if age_days <= 1:
        return normalized in {'pending', 'unshipped', 'shipped'}
    return normalized == 'shipped'


def _load_project_product_mapping(db: Session, project_name: str) -> tuple[set[str], set[str]]:
    rows = db.execute(select(ProductCost.sku, ProductCost.asin).where(ProductCost.project_name == project_name)).all()
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


def _parse_yyyy_mm_dd(value: str, field_name: str) -> date:
    text = (value or '').strip()
    try:
        return datetime.strptime(text, '%Y-%m-%d').date()
    except ValueError as exc:
        raise ValueError(f'{field_name} must be YYYY-MM-DD') from exc


def _classify_scope(
    *,
    sku: str | None,
    asin: str | None,
    known_skus: set[str],
    known_asins: set[str],
) -> tuple[str, str | None]:
    norm_sku = _normalize_identity(sku)
    norm_asin = _normalize_identity(asin)
    if not norm_sku and not norm_asin:
        return SCOPE_EXCLUDED_STORE, 'missing sku/asin'
    if norm_sku in known_skus or norm_asin in known_asins:
        return SCOPE_INCLUDED, None
    return SCOPE_EXCLUDED_UNMAPPED, 'sku/asin not found in product_costs'


def _build_aging_status(
    *,
    age_91_180: int,
    age_181_270: int,
    age_271_365: int,
    age_365_plus: int,
) -> str:
    if age_365_plus > 0:
        return 'over_aged'
    if age_91_180 + age_181_270 + age_271_365 > 0:
        return 'aging'
    return 'fresh'


def _project_slug(project_name: str) -> str:
    cleaned = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', '-', (project_name or '').strip())
    slug = slugify(cleaned)
    if not slug:
        slug = re.sub(r'\s+', '-', cleaned).strip(' .-').lower()
    return slug[:80] or 'project'


def _build_logical_filename(
    *,
    project_slug: str,
    report_type: str,
    period_start_date: date | None,
    period_end_date: date | None,
    snapshot_at: datetime,
    version: int,
    extension: str,
) -> str:
    safe_ext = extension if extension.startswith('.') else f'.{extension}' if extension else ''
    timestamp = snapshot_at.strftime('%Y%m%dT%H%M%SZ')
    if report_type == 'inventory_report':
        return f'{project_slug}__inventory_report__snapshot-{timestamp}__v{version}{safe_ext}'
    if period_start_date is None or period_end_date is None:
        raise ValueError(f'Missing period for {report_type}')
    return (
        f'{project_slug}__{report_type}__'
        f'{period_start_date.strftime("%Y%m%d")}_{period_end_date.strftime("%Y%m%d")}__'
        f'v{version}__{timestamp}{safe_ext}'
    )


def _build_storage_key(
    *,
    project_slug: str,
    report_type: str,
    period_start_date: date | None,
    period_end_date: date | None,
    snapshot_at: datetime,
    version: int,
    upload_file_id: str,
) -> str:
    if report_type == 'inventory_report':
        period_or_snapshot = f'snapshot-{snapshot_at.strftime("%Y%m%dT%H%M%SZ")}'
    else:
        if period_start_date is None or period_end_date is None:
            raise ValueError(f'Missing period for {report_type}')
        period_or_snapshot = f'{period_start_date.strftime("%Y%m%d")}_{period_end_date.strftime("%Y%m%d")}'
    return f'analysis/{project_slug}/{report_type}/{period_or_snapshot}/v{version}/{upload_file_id}'


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _restore_original_filename(file_id: str) -> str | None:
    value = (file_id or '').strip()
    if not value:
        return None
    parts = value.split('_', 1)
    if len(parts) == 2 and len(parts[0]) == 32:
        return parts[1]
    return value


def _match_columns(columns: list[str], aliases: dict[str, list[str]], label: str) -> dict[str, str]:
    mapped: dict[str, str] = {}
    for target, candidates in aliases.items():
        for candidate in candidates:
            if candidate in columns:
                mapped[target] = candidate
                break
    missing = [key for key in aliases if key not in mapped]
    if missing:
        raise ValueError(f'{label} missing required columns: {missing}')
    return mapped


def _to_int(value: Any) -> int:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return 0
    try:
        return int(float(str(value).strip() or '0'))
    except (TypeError, ValueError):
        return 0


def _to_decimal(value: Any) -> Decimal:
    if value is None:
        return Decimal('0')
    if isinstance(value, float) and pd.isna(value):
        return Decimal('0')
    try:
        text = str(value).strip().replace(',', '')
        if not text:
            return Decimal('0')
        return Decimal(text)
    except (InvalidOperation, ValueError):
        return Decimal('0')


def _to_decimal_with_currency(value: Any) -> Decimal:
    if value is None:
        return Decimal('0')
    if isinstance(value, float) and pd.isna(value):
        return Decimal('0')
    text = re.sub(r'[^0-9.\-]', '', str(value))
    if not text:
        return Decimal('0')
    try:
        return Decimal(text)
    except InvalidOperation:
        return Decimal('0')


def _sum_decimals(*values: Any) -> Decimal:
    total = Decimal('0')
    for value in values:
        total += _to_decimal(value)
    return total


def _normalize_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    if text.lower() == 'nan':
        return None
    return text


def _normalize_identity(value: Any) -> str:
    text = _normalize_text(value)
    if text is None:
        return ''
    return text.upper()


def _parse_transaction_at(row: Any) -> datetime | None:
    for key in ('date/time', 'transaction date', 'transaction_date', 'date'):
        if key not in row:
            continue
        value = row.get(key)
        if value is None:
            continue
        parsed = pd.to_datetime(value, utc=True, errors='coerce')
        if pd.isna(parsed):
            continue
        return parsed.to_pydatetime()
    return None


def _to_raw_row(row: dict[str, Any]) -> dict[str, Any]:
    payload: dict[str, Any] = {}
    for key, value in row.items():
        text_key = str(key)
        if value is None:
            payload[text_key] = None
            continue
        if isinstance(value, float) and pd.isna(value):
            payload[text_key] = None
            continue
        if hasattr(value, 'isoformat'):
            try:
                payload[text_key] = value.isoformat()
                continue
            except TypeError:
                pass
        if isinstance(value, (int, float, bool, str)):
            payload[text_key] = value
        else:
            payload[text_key] = str(value)
    return payload


def _get_row_model(report_type: str):
    if report_type == 'business_report':
        return AnalysisBusinessRow
    if report_type == 'payment_report':
        return AnalysisPaymentRow
    if report_type == 'ad_report':
        return AnalysisAdRow
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
    if report_type == 'ad_report':
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
            'currency': row.currency,
            'is_counted_sales': row.is_counted_sales,
            'status_rule_version': row.status_rule_version,
            'raw_row': row.raw_row,
        }
    raise ValueError(f'Unsupported report_type: {report_type}')
