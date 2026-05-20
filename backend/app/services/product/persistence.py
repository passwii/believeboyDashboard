"""Product analysis - source file persistence and PT1 calculation.

拆分自 product_analysis_source_service.py。
负责: SourcePersistOutcome, ensure_tables, persist_product_analysis_pt1_calculation,
      persist_product_analysis_sources, persist_single_analysis_source,
      persist_single_date_report_sources, _persist_one_source_file, _lookup_report_mapping_value,
      _restore_original_filename, _next_pt1_version, _build_pt_sku_detail_rows.
"""
from __future__ import annotations

import re
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import insert, or_, select, update as sa_update
from sqlalchemy.orm import Session

from app.models import (
    AnalysisAdProductRow,
    AnalysisBusinessRow,
    AnalysisPT1Calculation,
    AnalysisPTSKUDetail,
    AnalysisPaymentRow,
    AnalysisSalesOrderRow,
    AnalysisSourceFile,
    InventorySnapshotRow,
    Project,
)

from app.services.report_type_service import AD_PRODUCT_REPORT, normalize_report_type
from app.utils import (
    _parse_ad_rows,
    _parse_business_rows,
    _parse_inventory_rows,
    _parse_payment_rows,
    _parse_sales_rows,
    _validate_inventory_rows_against_project_mapping,
)
from app.utils.country import normalize_country as _normalize_country
from app.utils.text_utils import normalize_sku as _normalize_sku
from app.utils.text_utils import normalize_asin as _normalize_asin
from app.utils.payment_locale import read_payment_report_dataframe as _read_payment_report_locale
from app.utils import (
    _next_version,
    _replace_current_pointer,
    _write_report_upload_log,
    _build_logical_filename,
    _build_storage_key,
    _parse_yyyy_mm_dd,
    _project_slug,
    _restore_original_filename,
    _sha256_file,
    _to_raw_row,
)

from app.services.product._internal import (
    _get_row_model,
    _is_single_full_week,
)


class SourcePersistOutcome:
    __slots__ = ('report_type', 'source_id', 'success', 'error_message')

    def __init__(
        self,
        report_type: str,
        source_id: int | None,
        success: bool,
        error_message: str | None,
    ):
        self.report_type = report_type
        self.source_id = source_id
        self.success = success
        self.error_message = error_message


_SQLITE_TABLES_READY = False
_SQLITE_TABLES_LOCK: object  # threading.Lock, imported lazily


def _ensure_imports():
    """延迟导入 threading 以避免模块级副作用。"""
    import threading
    global _SQLITE_TABLES_LOCK, _ensure_tables
    _SQLITE_TABLES_LOCK = threading.Lock()


def ensure_tables(db: Session) -> None:
    """确保 SQLite 环境下的表已创建。"""
    global _SQLITE_TABLES_READY
    bind = db.get_bind()
    if bind.dialect.name != 'sqlite':
        return
    if _SQLITE_TABLES_READY:
        return
    import threading
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


def _lookup_report_mapping_value(mapping: dict[str, str], report_type: str) -> str:
    normalized = normalize_report_type(report_type)
    value = str(mapping.get(normalized) or '').strip()
    if value:
        return value
    from app.services.report_type_service import legacy_report_types_for
    for legacy_type in legacy_report_types_for(normalized):
        value = str(mapping.get(legacy_type) or '').strip()
        if value:
            return value
    return ''


ALL_REPORT_TYPES = {'business_report', 'payment_report', AD_PRODUCT_REPORT,
                    'sales_report', 'inventory_report', 'return_report'}


def _next_pt1_version(
    db: Session,
    *,
    project_id: int,
    country: str,
    report_start_date: date,
    report_end_date: date,
) -> int:
    from app.models.product_analysis_source import AnalysisPT1Calculation
    from sqlalchemy import func, select
    stmt = select(func.max(AnalysisPT1Calculation.version)).where(
        AnalysisPT1Calculation.project_id == project_id,
        AnalysisPT1Calculation.country == country,
        AnalysisPT1Calculation.report_start_date == report_start_date,
        AnalysisPT1Calculation.report_end_date == report_end_date,
    )
    value = db.execute(stmt).scalar_one_or_none()
    return int(value or 0) + 1


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
    from app.models.product_analysis_source import AnalysisPT1Calculation, AnalysisPTSKUDetail
    from sqlalchemy import insert, select, update as sa_update

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
        .values(is_current=False, superseded_at=now)
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


def _build_pt_sku_detail_rows(details: Any) -> list[dict[str, Any]]:
    if not isinstance(details, list):
        return []
    payloads: list[dict[str, Any]] = []
    for index, raw in enumerate(details):
        if not isinstance(raw, dict):
            continue
        sku = _normalize_text_func(raw.get('SKU'))
        if sku == '汇总':
            continue
        payloads.append({
            'pt1_calculation_id': 0,
            'source_row_no': index + 1,
            'report_date': _normalize_text_func(raw.get('日期')),
            'sku': sku,
            'asin': _normalize_text_func(raw.get('ASIN')),
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
        })
    return payloads


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
    created_by: str | None = None,
) -> SourcePersistOutcome:
    """持久化单个源文件到数据库。

    根据 report_type 选择对应的解析器，解析文件后批量插入对应的明细表，
    并创建 AnalysisSourceFile 元数据记录。
    """
    ensure_tables(db)
    normalized_country = _normalize_country(country)
    report_type = normalize_report_type(report_type)
    now = datetime.now(UTC)
    path = Path(upload_file_path)
    file_size_bytes = path.stat().st_size
    file_sha256 = _sha256_file(path)
    extension = (path.suffix or Path(upload_file_id).suffix or '').lower()
    project_slug = _project_slug(project.project_name)

    # 库存报告使用 snapshot_at，周期性报告使用 period 字段
    is_inventory = report_type == 'inventory_report'
    version = _next_version(
        db,
        project_id=project.id,
        report_type=report_type,
        country=normalized_country,
        period_start_date=period_start_date,
        period_end_date=period_end_date,
    )

    source = AnalysisSourceFile(
        project_id=project.id,
        report_type=report_type,
        country=normalized_country,
        report_date=report_date,
        period_start_date=period_start_date,
        period_end_date=period_end_date,
        snapshot_at=now if is_inventory else None,
        version=version,
        is_current=False,
        superseded_at=None,
        upload_file_id=upload_file_id,
        upload_file_path=upload_file_path,
        original_filename=_restore_original_filename(upload_file_id),
        stored_filename=upload_file_id,
        logical_filename=_build_logical_filename(
            project_slug=project_slug,
            report_type=report_type,
            period_start_date=period_start_date,
            period_end_date=period_end_date,
            snapshot_at=now,
            version=version,
            extension=extension,
        ),
        storage_key=_build_storage_key(
            project_slug=project_slug,
            report_type=report_type,
            period_start_date=period_start_date,
            period_end_date=period_end_date,
            snapshot_at=now if is_inventory else None,
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

    # ── 解析文件 ──
    row_model = _get_row_model(report_type)
    if report_type == 'business_report':
        payloads, total, included = _parse_business_rows(path, source.id)
    elif report_type == 'payment_report':
        payloads, total, included = _parse_payment_rows(
            _read_payment_report_locale(path), source.id,
            known_skus, known_asins,
        )
    elif report_type == AD_PRODUCT_REPORT:
        payloads, total, included = _parse_ad_rows(path, source.id, known_skus, known_asins)
    elif report_type == 'inventory_report':
        payloads, total, included = _parse_inventory_rows(path, source.id)
        _validate_inventory_rows_against_project_mapping(
            payloads,
            project_name=project.project_name,
            country=normalized_country,
            known_skus=known_skus,
            known_asins=known_asins,
        )
    elif report_type == 'sales_report':
        payloads, total, included = _parse_sales_rows(path, source.id, country=normalized_country)
    else:
        raise ValueError(f'Unsupported report_type: {report_type}')

    # ── 批量插入明细行 ──
    if payloads:
        db.execute(insert(row_model), payloads)

    # ── 更新 source 元数据 ──
    source.row_count_total = total
    source.row_count_included = included
    source.ingestion_status = 'success'
    db.flush()

    # ── 标记为 current ──
    _replace_current_pointer(db, source)
    source.is_current = True
    source.superseded_at = None
    db.flush()

    _write_report_upload_log(
        db,
        project.id,
        normalized_country,
        report_type,
        source_file_id=source.id,
        has_real_data=total > 0,
        row_count=total,
        original_filename=_restore_original_filename(upload_file_id),
    )

    return SourcePersistOutcome(
        report_type=report_type,
        source_id=source.id,
        success=True,
        error_message=None,
    )


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
            outcomes.append(SourcePersistOutcome(
                report_type=report_type, source_id=None,
                success=False, error_message=f'missing file for {report_type}',
            ))
            continue

        outcome = _persist_one_source_file(
            db,
            project=project,
            report_type=report_type,
            country=normalized_country,
            report_date=None,
            period_start_date=start_date if report_type in ('business_report', 'payment_report', AD_PRODUCT_REPORT) else None,
            period_end_date=end_date if report_type in ('business_report', 'payment_report', AD_PRODUCT_REPORT) else None,
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

    for report_type in ('business_report', AD_PRODUCT_REPORT):
        file_id = _lookup_report_mapping_value(file_ids, report_type)
        file_path = _lookup_report_mapping_value(resolved_file_paths, report_type)
        if not file_id and not file_path:
            outcomes.append(SourcePersistOutcome(
                report_type=report_type, source_id=None,
                success=False, error_message=f'missing file for {report_type}',
            ))
            continue
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
        outcomes.append(SourcePersistOutcome(
            report_type='inventory_report', source_id=None,
            success=False, error_message='missing file for inventory_report',
        ))
        return outcomes

    outcomes.append(_persist_one_source_file(
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
    ))
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
    """销售报告按购买日期拆分持久化。"""
    from app.models import Project
    from app.utils.parsers import _parse_sales_rows

    ensure_tables(db)
    project = _get_project_by_name(db, project_name)  # type: ignore[arg-type]
    normalized_country = _normalize_country(country)
    path = Path(upload_file_path)
    if not path.exists() or not path.is_file():
        raise FileNotFoundError(f'File not found: {upload_file_path}')

    rows, total, _ = _parse_sales_rows(path, 0, None, country=normalized_country)
    grouped_rows: dict[date, list[dict[str, Any]]] = {}
    for row in rows:
        purchase_date_pt = row.get('purchase_date_pt')
        if isinstance(purchase_date_pt, date):
            grouped_rows.setdefault(purchase_date_pt, []).append(row)

    if not grouped_rows:
        target_date = date.today()
        version = _next_version(
            db, project_id=project.id, report_type='sales_report',
            country=normalized_country,
            period_start_date=target_date, period_end_date=target_date,
        )
        now = datetime.now(UTC)
        file_size_bytes = path.stat().st_size
        file_sha256 = _sha256_file(path)
        extension = (path.suffix or Path(upload_file_id).suffix or '').lower()
        project_slug = _project_slug(project.project_name)
        source = AnalysisSourceFile(
            project_id=project.id, report_type='sales_report',
            country=normalized_country, report_date=target_date,
            period_start_date=target_date, period_end_date=target_date,
            snapshot_at=None, version=version, is_current=False,
            superseded_at=None, upload_file_id=upload_file_id,
            upload_file_path=upload_file_path,
            original_filename=_restore_original_filename(upload_file_id),
            stored_filename=upload_file_id,
            logical_filename=_build_logical_filename(
                project_slug=project_slug, report_type='sales_report',
                period_start_date=target_date, period_end_date=target_date,
                snapshot_at=now, version=version, extension=extension,
            ),
            storage_key=_build_storage_key(
                project_slug=project_slug, report_type='sales_report',
                period_start_date=target_date, period_end_date=target_date,
                snapshot_at=now, version=version, upload_file_id=upload_file_id,
            ),
            file_size_bytes=file_size_bytes, file_sha256=file_sha256,
            ingestion_status='success', ingestion_error=None,
            row_count_total=0, row_count_included=0,
            created_by=(created_by or '').strip()[:255] or None,
        )
        db.add(source)
        db.commit()
        _write_report_upload_log(
            db, project.id, normalized_country, 'sales_report',
            source_file_id=source.id, has_real_data=False, row_count=0,
            original_filename=_restore_original_filename(upload_file_id),
        )
        db.commit()
        return {
            'success': True, 'latest_source_id': source.id,
            'report_start_date': target_date.isoformat(),
            'report_end_date': target_date.isoformat(),
            'report_dates': [target_date.isoformat()],
            'days_persisted': 1, 'row_count_total': 0,
            'message': '销售报表无有效购买日期记录，已记录空上传',
        }

    file_size_bytes = path.stat().st_size
    file_sha256 = _sha256_file(path)
    extension = (path.suffix or Path(upload_file_id).suffix or '').lower()
    project_slug = _project_slug(project.project_name)
    latest_source_id: int | None = None

    for report_date in sorted(grouped_rows):
        version = _next_version(
            db, project_id=project.id, report_type='sales_report',
            country=normalized_country,
            period_start_date=report_date, period_end_date=report_date,
        )
        now = datetime.now(UTC)
        source = AnalysisSourceFile(
            project_id=project.id, report_type='sales_report',
            country=normalized_country, report_date=report_date,
            period_start_date=report_date, period_end_date=report_date,
            snapshot_at=None, version=version, is_current=False,
            superseded_at=None, upload_file_id=upload_file_id,
            upload_file_path=upload_file_path,
            original_filename=_restore_original_filename(upload_file_id),
            stored_filename=upload_file_id,
            logical_filename=_build_logical_filename(
                project_slug=project_slug, report_type='sales_report',
                period_start_date=report_date, period_end_date=report_date,
                snapshot_at=now, version=version, extension=extension,
            ),
            storage_key=_build_storage_key(
                project_slug=project_slug, report_type='sales_report',
                period_start_date=report_date, period_end_date=report_date,
                snapshot_at=now, version=version, upload_file_id=upload_file_id,
            ),
            file_size_bytes=file_size_bytes, file_sha256=file_sha256,
            ingestion_status='running', ingestion_error=None,
            row_count_total=0, row_count_included=0,
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

    db.commit()
    _write_report_upload_log(
        db, project.id, normalized_country, 'sales_report',
        source_file_id=latest_source_id, has_real_data=total > 0,
        row_count=total,
        original_filename=_restore_original_filename(upload_file_id),
    )
    db.commit()
    report_dates = sorted(grouped_rows)
    return {
        'success': True, 'latest_source_id': latest_source_id,
        'report_start_date': report_dates[0].isoformat(),
        'report_end_date': report_dates[-1].isoformat(),
        'report_dates': [item.isoformat() for item in report_dates],
        'days_persisted': len(report_dates), 'row_count_total': total,
        'message': (
            f'销售报表已按购买日期自动拆分为 {len(report_dates)} 个报表日期，'
            f'范围 {report_dates[0].isoformat()} ~ {report_dates[-1].isoformat()}'
        ),
    }


def _normalize_text_func(value):
    from app.utils.text_utils import normalize_text
    return normalize_text(value)


def _to_int(value):
    from app.utils.utils import to_int as _to_int_fn
    return _to_int_fn(value)


def _to_decimal(value):
    from app.utils.utils import to_decimal as _to_decimal_fn
    return _to_decimal_fn(value)


def _load_project_product_mapping(db: Session, project_name: str, country: str = 'US'):
    from app.models import SkuRecord
    from sqlalchemy import select
    rows = db.execute(
        select(SkuRecord.sku, SkuRecord.asin).where(
            SkuRecord.project_name == project_name,
            SkuRecord.is_active.is_(True),
            SkuRecord.country == _normalize_country(country),
        )
    ).all()
    known_skus = {_normalize_sku(value) for value, _ in rows if value}
    known_asins = {_normalize_asin(value) for _, value in rows if value}
    return known_skus, known_asins


def _get_project_by_name(db: Session, project_name: str) -> Project:
    normalized = (project_name or '').strip()
    if not normalized:
        raise ValueError('project_name is required')
    project = db.execute(select(Project).where(Project.project_name == normalized)).scalars().first()
    if project is None:
        raise ValueError(f'Project not found: {normalized}')
    return project