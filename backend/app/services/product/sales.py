"""Product analysis - sales report persistence.

拆分自 product_analysis_source_service.py 的 persist_sales_report_by_purchase_date。

支持多站点订单拆分：当单个文件包含多个国家站点（UK/DE）的订单时，
自动按站点拆分为多个 AnalysisSourceFile 记录。
"""
from __future__ import annotations

from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import insert, select
from sqlalchemy.orm import Session

from app.models import AnalysisSalesOrderRow, AnalysisSourceFile, Project

from app.utils import (
    _build_logical_filename,
    _build_storage_key,
    _next_version,
    _parse_yyyy_mm_dd,
    _project_slug,
    _restore_original_filename,
    _sha256_file,
    _to_raw_row,
    _write_report_upload_log,
)
from app.utils.parsers import parse_sales_rows as _parse_sales_rows
from app.utils.parsers import detect_countries_in_sales_file
from app.services.product._internal import _normalize_country


def persist_sales_report_by_purchase_date(
    db: Session,
    *,
    project_name: str,
    upload_file_id: str,
    upload_file_path: str,
    country: str = 'US',
    created_by: str | None = None,
) -> dict[str, Any]:
    """销售报告按购买日期拆分持久化。

    支持多站点文件：自动检测文件中的所有站点，按站点+日期拆分为多个 source_file。
    """
    project = db.execute(select(Project).where(Project.project_name == project_name)).scalar_one_or_none()
    if project is None:
        raise ValueError(f'Project not found: {project_name}')

    normalized_country = _normalize_country(country)
    path = Path(upload_file_path)
    if not path.exists() or not path.is_file():
        raise FileNotFoundError(f'File not found: {upload_file_path}')

    # 检测文件中的所有站点
    detected_countries = detect_countries_in_sales_file(path)
    if len(detected_countries) == 1:
        # 单站点文件，使用原有逻辑
        return _persist_single_country(
            db, project, upload_file_id, path,
            detected_countries[0], created_by,
        )

    # 多站点文件：按站点+日期拆分
    return _persist_multi_country(
        db, project, upload_file_id, path,
        detected_countries, created_by,
    )


def _persist_single_country(
    db: Session,
    project: Project,
    upload_file_id: str,
    path: Path,
    country: str,
    created_by: str | None,
) -> dict[str, Any]:
    """处理单站点文件（原有逻辑）。"""
    rows, total, _ = _parse_sales_rows(path, 0, None, country=country)
    grouped_rows: dict[date, list[dict[str, Any]]] = {}
    for row in rows:
        purchase_date_pt = row.get('purchase_date_pt')
        if isinstance(purchase_date_pt, date):
            grouped_rows.setdefault(purchase_date_pt, []).append(row)

    if not grouped_rows:
        return _create_empty_source_file(db, project, upload_file_id, path, country, created_by)

    file_size_bytes = path.stat().st_size
    file_sha256 = _sha256_file(path)
    extension = (path.suffix or Path(upload_file_id).suffix or '').lower()
    project_slug = _project_slug(project.project_name)

    latest_source_id: int | None = None
    for report_date in sorted(grouped_rows):
        version = _next_version(
            db,
            project_id=project.id,
            report_type='sales_report',
            country=country,
            period_start_date=report_date,
            period_end_date=report_date,
        )
        now = datetime.now(UTC)
        source = AnalysisSourceFile(
            project_id=project.id,
            report_type='sales_report',
            country=country,
            report_date=report_date,
            period_start_date=report_date,
            period_end_date=report_date,
            snapshot_at=None,
            version=version,
            is_current=False,
            superseded_at=None,
            upload_file_id=upload_file_id,
            upload_file_path=str(path),
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

        from app.utils.persist_helpers import replace_current_pointer
        replace_current_pointer(db, source)
        source.is_current = True
        source.superseded_at = None
        db.flush()

        latest_source_id = source.id

    db.commit()
    _write_report_upload_log(
        db, project.id, country, 'sales_report',
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


def _persist_multi_country(
    db: Session,
    project: Project,
    upload_file_id: str,
    path: Path,
    countries: list[str],
    created_by: str | None,
) -> dict[str, Any]:
    """处理多站点文件：按站点+日期拆分为多个 source_file。"""
    # 一次性解析所有行
    all_rows, total, _ = _parse_sales_rows(path, 0, None, country=countries[0] if countries else 'US')

    # 按 (country, date) 分组
    grouped: dict[tuple[str, date], list[dict[str, Any]]] = {}
    for row in all_rows:
        row_country = row.get('country', 'US')
        purchase_date_pt = row.get('purchase_date_pt')
        if isinstance(purchase_date_pt, date):
            key = (row_country, purchase_date_pt)
            grouped.setdefault(key, []).append(row)

    if not grouped:
        # 无有效数据，创建一个空文件记录
        return _create_empty_source_file(
            db, project, upload_file_id, path, countries[0] if countries else 'US', created_by
        )

    file_size_bytes = path.stat().st_size
    file_sha256 = _sha256_file(path)
    extension = (path.suffix or Path(upload_file_id).suffix or '').lower()
    project_slug = _project_slug(project.project_name)

    all_source_ids: list[int] = []
    all_report_dates: list[date] = []

    # 按国家分组汇总
    country_stats: dict[str, dict[str, Any]] = {}

    for (row_country, report_date), rows in sorted(grouped.items()):
        version = _next_version(
            db,
            project_id=project.id,
            report_type='sales_report',
            country=row_country,
            period_start_date=report_date,
            period_end_date=report_date,
        )
        now = datetime.now(UTC)

        source = AnalysisSourceFile(
            project_id=project.id,
            report_type='sales_report',
            country=row_country,
            report_date=report_date,
            period_start_date=report_date,
            period_end_date=report_date,
            snapshot_at=None,
            version=version,
            is_current=False,
            superseded_at=None,
            upload_file_id=upload_file_id,
            upload_file_path=str(path),
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

        included = 0
        payloads: list[dict[str, Any]] = []
        for row in rows:
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

        from app.utils.persist_helpers import replace_current_pointer
        replace_current_pointer(db, source)
        source.is_current = True
        source.superseded_at = None
        db.flush()

        all_source_ids.append(source.id)
        if report_date not in all_report_dates:
            all_report_dates.append(report_date)

        # 统计
        if row_country not in country_stats:
            country_stats[row_country] = {'count': 0, 'included': 0}
        country_stats[row_country]['count'] += len(payloads)
        country_stats[row_country]['included'] += included

    db.commit()
    _write_report_upload_log(
        db, project.id, countries[0], 'sales_report',
        source_file_id=all_source_ids[0] if all_source_ids else None,
        has_real_data=total > 0,
        row_count=total,
        original_filename=_restore_original_filename(upload_file_id),
    )
    db.commit()

    # 构建返回消息
    country_summary = ', '.join(
        f"{c}: {s['count']}条" for c, s in sorted(country_stats.items())
    )
    total_dates = len(all_report_dates)

    return {
        'success': True,
        'latest_source_id': all_source_ids[-1] if all_source_ids else None,
        'source_file_ids': all_source_ids,
        'countries': countries,
        'country_stats': country_stats,
        'report_start_date': all_report_dates[0].isoformat() if all_report_dates else None,
        'report_end_date': all_report_dates[-1].isoformat() if all_report_dates else None,
        'report_dates': [d.isoformat() for d in sorted(all_report_dates)],
        'days_persisted': total_dates,
        'row_count_total': total,
        'message': (
            f'销售报表已按站点+日期自动拆分 [{country_summary}]，'
            f'共 {total_dates} 个报表日期'
        ),
    }


def _create_empty_source_file(
    db: Session,
    project: Project,
    upload_file_id: str,
    path: Path,
    country: str,
    created_by: str | None,
) -> dict[str, Any]:
    """创建空的上传记录（无有效数据时使用）。"""
    target_date = date.today()
    version = _next_version(
        db,
        project_id=project.id,
        report_type='sales_report',
        country=country,
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
        country=country,
        report_date=target_date,
        period_start_date=target_date,
        period_end_date=target_date,
        snapshot_at=None,
        version=version,
        is_current=False,
        superseded_at=None,
        upload_file_id=upload_file_id,
        upload_file_path=str(path),
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
        db, project.id, country, 'sales_report',
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