"""
File processor: recognize → persist to DB → move file.
Uses shared utilities from backend/app/utils/.
"""

from __future__ import annotations

import logging
import re
import shutil
import uuid
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

import pandas as pd
from dotenv import load_dotenv
from sqlalchemy import insert, select, update as sa_update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

# Load autoReportUpload .env before importing backend modules
_env_path = Path(__file__).parent / ".env"
load_dotenv(_env_path)

from config import IS_LOCAL, PROCESSED_SUBDIR
from models import (
    AnalysisAdProductRow,
    AnalysisBusinessRow,
    AnalysisPaymentRow,
    AnalysisReturnRow,
    AnalysisSalesOrderRow,
    AnalysisSourceFile,
    InventorySnapshotRow,
    ProductCost,
    Project,
    ReportUploadLog,
)
from recognition import (
    AD_PRODUCT_REPORT,
    recognize_file,
    _read_csv_with_encoding_fallback as _recog_csv,
)

# Payment report parsing — use locale (single source of truth)
from app.utils.payment_locale import read_payment_report_dataframe

# Shared utilities from backend/app/utils/utils.py
from app.utils.utils import (
    to_int as _to_int,
    to_decimal as _to_decimal,
    to_decimal_with_currency as _to_decimal_with_currency,
    to_raw_row as _to_raw_row,
    sha256_file as _sha256_file,
    project_slug as _project_slug,
    build_logical_filename as _build_logical_filename,
    parse_yyyy_mm_dd as _parse_yyyy_mm_dd,
)

# Shared text utilities from backend/app/utils/text_utils.py
from app.utils.text_utils import (
    normalize_text as _normalize_text,
    normalize_identity as _normalize_identity,
    normalize_sku as _normalize_sku,
    normalize_asin as _normalize_asin,
)

# Shared parsers — single source of truth (backend/app/utils/parsers.py)
from app.utils.parsers import (
    COUNTRY_TIMEZONE,
    PT_TIMEZONE,
    SCOPE_INCLUDED,
    SCOPE_EXCLUDED_UNMAPPED,
    read_excel_no_warning as _read_excel_no_warning,
    parse_business_rows as _parse_business_rows,
    parse_payment_rows as _parse_payment_rows,
    parse_ad_rows as _parse_ad_rows,
    parse_inventory_rows as _parse_inventory_rows,
    parse_sales_rows as _parse_sales_rows,
    parse_return_rows as _parse_return_rows,
    validate_inventory_rows_against_project_mapping as _validate_inventory,
    parse_transaction_at as _parse_transaction_at,
)

# Shared persist helpers — single source of truth (backend/app/utils/persist_helpers.py)
from app.utils.persist_helpers import (
    PERIODIC_REPORT_TYPES,
    next_version as _next_version,
    replace_current_pointer as _replace_current_pointer,
)

logger = logging.getLogger(__name__)

_MONTH_MAP = {
    "jan": 1,
    "feb": 2,
    "mar": 3,
    "apr": 4,
    "may": 5,
    "jun": 6,
    "jul": 7,
    "aug": 8,
    "sep": 9,
    "oct": 10,
    "nov": 11,
    "dec": 12,
}

_PAYMENT_FILENAME_RE = re.compile(
    r"(?i)(\d{4})(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)(\d{1,2})"
    r"\s*-\s*"
    r"(\d{4})(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)(\d{1,2})"
    r"customtransaction"
)


def _resolve_upload_date(now: datetime) -> date:
    """返回当前本地日期作为 upload_log 日期。"""
    return now.date()


def _write_upload_log(
    db: Session,
    project_id: int,
    report_type: str,
    country: str,
    upload_date: date,
    has_real_data: bool,
    row_count: int,
    source_file_id: int | None,
    original_filename: str,
) -> None:
    """Write a single upload log entry."""
    log = ReportUploadLog(
        project_id=project_id,
        report_type=report_type,
        country=country,
        upload_date=upload_date,
        has_real_data=has_real_data,
        row_count=row_count,
        source_file_id=source_file_id,
        original_filename=original_filename,
    )
    db.add(log)


def _write_dedup_upload_log(
    db: Session,
    filename: str,
    project_name: str,
    report_type: str,
    country: str,
    duplicates: list[dict],
) -> None:
    """Write today's upload log when a file is skipped (duplicate or conflict).

    Even though the file content hasn't changed or data already exists,
    the autoReportUpload service DID process it — this ensures the RPA
    status grid shows green for today.
    """
    try:
        project = _get_project_by_name(db, project_name)
    except ValueError:
        return  # Project not found, skip

    now = datetime.now()
    upload_date = _resolve_upload_date(now)

    # Idempotency: skip if a log already exists for today
    existing = db.execute(
        select(ReportUploadLog).where(
            ReportUploadLog.project_id == project.id,
            ReportUploadLog.report_type == report_type,
            ReportUploadLog.country == country,
            ReportUploadLog.upload_date == upload_date,
        )
    ).scalars().first()
    if existing is not None:
        return

    # Find the duplicate that matches this project + report type
    matching_dup = None
    for d in duplicates:
        if d["project_id"] == project.id and d["report_type"] == report_type:
            matching_dup = d
            break

    if matching_dup:
        has_real_data = matching_dup["row_count_total"] > 0
        row_count = matching_dup["row_count_total"]
        source_file_id = matching_dup["source_id"]
    else:
        # No exact match — still write a log to mark today as processed
        has_real_data = False
        row_count = 0
        source_file_id = None

    _write_upload_log(
        db,
        project_id=project.id,
        report_type=report_type,
        country=country,
        upload_date=upload_date,
        has_real_data=has_real_data,
        row_count=row_count,
        source_file_id=source_file_id,
        original_filename=filename,
    )
    db.commit()


# ─── Result dataclass ─────────────────────────────────────────────────────────


class ProcessResult:
    """Describes the outcome of processing a single file."""

    def __init__(
        self,
        *,
        skipped: bool = False,
        success: bool = False,
        report_type: str = "",
        reason: str = "",
        source_id: int | None = None,
        row_count: int = 0,
        error: str = "",
        country: str = "",
        detected_start_date: str | None = None,
        detected_end_date: str | None = None,
    ):
        self.skipped = skipped
        self.success = success
        self.report_type = report_type
        self.reason = reason
        self.source_id = source_id
        self.row_count = row_count
        self.error = error
        self.country = country
        self.detected_start_date = detected_start_date
        self.detected_end_date = detected_end_date

    def __repr__(self) -> str:
        if self.skipped:
            return f"[SKIP] {self.report_type}: {self.reason}"
        if self.success:
            return f"[OK] {self.report_type}: {self.row_count} rows, source_id={self.source_id}"
        return f"[FAIL] {self.report_type}: {self.error}"


# ─── Entry point ─────────────────────────────────────────────────────────────


def process_file(
    file_path: Path,
    project_name: str,
    db: Session,
    dry_run: bool = False,
) -> ProcessResult:
    """
    Recognize a file, persist it to DB, and move it to the processed/ subfolder.
    Returns a ProcessResult describing what happened.
    """
    import time
    t0 = time.time()

    # 1. Recognize
    result = recognize_file(db, file_path, original_filename=file_path.name, country="US")
    t1 = time.time()

    if result is None:
        return ProcessResult(skipped=True, reason="未匹配任何报表类型")

    if result.project_match is None:
        return ProcessResult(skipped=True, reason="未匹配到项目信息")

    match_status = result.project_match.get("status")
    if match_status != "matched":
        return ProcessResult(
            skipped=True,
            report_type=result.report_type,
            reason=f"项目匹配状态为 {match_status}：{result.project_match.get('message', '')}",
        )

    matched_project = result.project_match.get("project_name", "")
    if matched_project != project_name:
        return ProcessResult(
            skipped=True,
            report_type=result.report_type,
            reason=f"文件匹配项目 '{matched_project}' 与目标项目 '{project_name}' 不一致，跳过",
        )

    if dry_run:
        return ProcessResult(
            success=True,
            report_type=result.report_type,
            reason=(
                f"[dry-run] 会入库 {result.report_type}，"
                f"行数预估 {result.row_count_preview}，国家 {result.country}"
            ),
        )

    # SHA-256 duplicate detection: exact same file is treated as already handled
    file_sha256 = _sha256_file(file_path)
    duplicates = _find_sha256_duplicates(db, file_sha256)
    if duplicates:
        dup_info = ", ".join(
            f"项目ID={d['project_id']}({d['report_type']}/{d['country']})"
            for d in duplicates
        )
        logger.warning(
            "SHA-256 重复文件: %s | 已存在: %s",
            file_path.name,
            dup_info,
        )
        # Write today's upload log so RPA status grid shows green
        _write_dedup_upload_log(
            db, file_path.name, project_name,
            result.report_type, result.country or "US", duplicates,
        )
        if not IS_LOCAL:
            _move_to_processed(file_path)
        return ProcessResult(
            skipped=True,
            report_type=result.report_type,
            reason="检测到 SHA-256 重复文件，已视为处理完成并归档" if not IS_LOCAL else "检测到 SHA-256 重复文件，local 模式下不移动文件",
        )

    # 2. Persist to DB
    try:
        outcome = _persist_one_file(db, file_path, project_name, result)
    except Exception as exc:  # noqa: BLE001
        return ProcessResult(
            skipped=False,
            success=False,
            report_type=result.report_type,
            reason="入库异常",
            error=str(exc),
        )
    t2 = time.time()

    if not outcome.get("success"):
        error_msg = str(outcome.get("error", ""))
        is_duplicate = (
            "UniqueViolation" in error_msg
            or "duplicate key" in error_msg.lower()
            or "uq_return_record_key" in error_msg
        )
        if is_duplicate:
            # Write today's upload log — service DID process this file
            _write_dedup_upload_log(
                db, file_path.name, project_name,
                result.report_type, result.country or "US",
                _find_sha256_duplicates(db, file_sha256),
            )
            if not IS_LOCAL:
                _move_to_processed(file_path)
            return ProcessResult(
                skipped=True,
                report_type=result.report_type,
                reason="数据已存在（唯一约束冲突），文件已移走" if not IS_LOCAL else "数据已存在（唯一约束冲突），local 模式下不移动文件",
            )
        return ProcessResult(
            skipped=False,
            success=False,
            report_type=result.report_type,
            reason="入库失败",
            error=error_msg,
        )

    # 3. Move file to processed/ (skip in local env)
    if not IS_LOCAL:
        _move_to_processed(file_path)

    total_time = time.time() - t0
    return ProcessResult(
        success=True,
        report_type=result.report_type,
        source_id=outcome.get("source_id"),
        row_count=outcome.get("row_count", 0),
        country=result.country,
        detected_start_date=result.detected_start_date,
        detected_end_date=result.detected_end_date,
        reason=(
            f"{outcome.get('report_start_date', '')}"
            f"{'–' if outcome.get('report_start_date') and outcome.get('report_end_date') else ''}"
            f"{outcome.get('report_end_date', '')}"
            f"  [识别{t1-t0:.1f}s+入库{t2-t1:.1f}s+移动{time.time()-t2:.1f}s=总{total_time:.1f}s]"
        ),
    )


# ─── Persistence ──────────────────────────────────────────────────────────────


def _persist_one_file(
    db: Session,
    file_path: Path,
    project_name: str,
    result,
) -> dict[str, Any]:
    """Persist a recognized file to the database."""
    import time
    t0 = time.time()

    project = _get_project_by_name(db, project_name)
    report_type = result.report_type
    country = result.country or "US"
    now = datetime.now()

    t1 = time.time()
    known_skus, known_asins = _load_project_product_mapping(db, project_name, country)
    t2 = time.time()

    period_start: date | None = None
    period_end: date | None = None
    report_date: date | None = None
    snapshot_at: datetime | None = None

    if report_type == "sales_report":
        dates = _extract_sales_report_dates(file_path, country)
        if dates:
            period_start = period_end = dates[0]
            report_date = dates[0]
    elif report_type == "inventory_report":
        if result.detected_date:
            report_date = _parse_yyyy_mm_dd(result.detected_date)
        snapshot_at = now
    elif report_type == "payment_report":
        filename_period = _parse_payment_period_from_filename(file_path.name)
        if result.detected_start_date and result.detected_end_date:
            period_start = _parse_yyyy_mm_dd(result.detected_start_date)
            period_end = _parse_yyyy_mm_dd(result.detected_end_date)
            report_date = period_end
        elif result.detected_date:
            report_date = _parse_yyyy_mm_dd(result.detected_date)
            period_start = period_end = report_date
        elif filename_period:
            period_start, period_end = filename_period
            report_date = period_end
    else:
        if result.detected_date:
            report_date = _parse_yyyy_mm_dd(result.detected_date)
            period_start = period_end = report_date
        elif result.detected_start_date and result.detected_end_date:
            period_start = _parse_yyyy_mm_dd(result.detected_start_date)
            period_end = _parse_yyyy_mm_dd(result.detected_end_date)
            report_date = period_end

    file_id = _generate_file_id(file_path.name)
    extension = file_path.suffix.lower()
    project_slug = _project_slug(project_name)

    if report_type == "sales_report":
        return _persist_sales_report(
            db, file_path, project, country, file_id, extension,
            project_slug, known_skus, known_asins, now,
        )

    if report_type == "return_report":
        return _persist_return_report(db, file_path, project, country)

    return _persist_single_source(
        db, file_path, project, report_type, country,
        file_id, extension, project_slug,
        report_date, period_start, period_end, snapshot_at,
        known_skus, known_asins, now,
    )


def _persist_single_source(
    db: Session,
    file_path: Path,
    project: Project,
    report_type: str,
    country: str,
    file_id: str,
    extension: str,
    project_slug: str,
    report_date: date | None,
    period_start: date | None,
    period_end: date | None,
    snapshot_at: datetime | None,
    known_skus: set[str],
    known_asins: set[str],
    now: datetime,
) -> dict[str, Any]:
    import time
    t0 = time.time()

    # Fallback: 空文件无法提取日期时，用当天日期作为 period
    # 避免 _build_storage_key 因 period=None 抛出 ValueError
    if period_start is None and period_end is None:
        upload_fallback_date = now.date()
        period_start = period_end = upload_fallback_date
        if report_date is None:
            report_date = upload_fallback_date

    version = _next_version(
        db, project_id=project.id, report_type=report_type, country=country,
        period_start_date=period_start, period_end_date=period_end,
    )
    logical_filename = _build_logical_filename(
        project_slug, report_type, period_start, period_end, now, version, extension
    )
    storage_key = _build_storage_key(
        project_slug, report_type, period_start, period_end, version, file_id
    )

    source = AnalysisSourceFile(
        project_id=project.id,
        report_type=report_type,
        country=country,
        report_date=report_date,
        period_start_date=period_start,
        period_end_date=period_end,
        snapshot_at=snapshot_at,
        version=version,
        is_current=False,
        superseded_at=None,
        upload_file_id=file_id,
        upload_file_path=str(file_path),
        original_filename=file_path.name,
        stored_filename=file_id,
        logical_filename=logical_filename,
        storage_key=storage_key,
        file_size_bytes=file_path.stat().st_size,
        file_sha256=_sha256_file(file_path),
        ingestion_status="running",
        row_count_total=0,
        row_count_included=0,
    )
    db.add(source)
    db.flush()

    t1 = time.time()
    total, included = _parse_and_insert_rows(
        db, file_path, source.id, report_type, known_skus, known_asins,
        project_name=project.project_name, country=country,
    )
    t2 = time.time()
    source.row_count_total = total
    source.row_count_included = included
    source.ingestion_status = "success"

    _replace_current_pointer(db, source)
    source.is_current = True
    source.superseded_at = None
    db.flush()

    # Write upload log（使用本地时间）
    upload_date = _resolve_upload_date(now)
    _write_upload_log(
        db,
        project_id=project.id,
        report_type=report_type,
        country=country,
        upload_date=upload_date,
        has_real_data=total > 0,
        row_count=total,
        source_file_id=source.id,
        original_filename=file_path.name,
    )

    db.commit()
    t3 = time.time()

    return {
        "success": True,
        "source_id": source.id,
        "row_count": total,
        "report_start_date": period_start.isoformat() if period_start else None,
        "report_end_date": period_end.isoformat() if period_end else None,
        "_timing": f"setup={t1-t0:.1f}s parse={t2-t1:.1f}s commit={t3-t2:.1f}s total={t3-t0:.1f}s",
    }


# ─── Return report ────────────────────────────────────────────────────────────

def _persist_return_report(
    db: Session,
    file_path: Path,
    project: Project,
    country: str,
) -> dict[str, Any]:
    """Persist return report to AnalysisSourceFile + AnalysisReturnRow."""
    now = datetime.now()
    upload_date = now.date()

    # Create source file record
    file_id = _generate_file_id(file_path.name)
    extension = file_path.suffix.lower()
    project_slug = _project_slug(project.project_name)
    version = _next_version(
        db, project_id=project.id, report_type="return_report", country=country,
        period_start_date=upload_date, period_end_date=upload_date,
    )
    logical_filename = _build_logical_filename(
        project_slug, "return_report", upload_date, upload_date, now, version, extension
    )
    storage_key = _build_storage_key(
        project_slug, "return_report", upload_date, upload_date, version, file_id
    )

    source = AnalysisSourceFile(
        project_id=project.id,
        report_type="return_report",
        country=country,
        report_date=None,
        period_start_date=upload_date,
        period_end_date=upload_date,
        snapshot_at=None,
        version=version,
        is_current=False,
        superseded_at=None,
        upload_file_id=file_id,
        upload_file_path=str(file_path),
        original_filename=file_path.name,
        stored_filename=file_id,
        logical_filename=logical_filename,
        storage_key=storage_key,
        file_size_bytes=file_path.stat().st_size,
        file_sha256=_sha256_file(file_path),
        ingestion_status="running",
        row_count_total=0,
        row_count_included=0,
    )
    db.add(source)
    db.flush()

    # Parse return rows — delegates to shared parser (single source of truth)
    df = _recog_csv(file_path, sep="\t")
    df.columns = [str(c).strip() for c in df.columns]

    try:
        parsed_rows, raw_datetimes = _parse_return_rows(df)
    except ValueError as exc:
        source.ingestion_status = "failed"
        source.ingestion_error = str(exc)
        db.commit()
        return {"success": False, "error": str(exc)}

    rows: list[dict] = []
    all_us_dates: list[date] = []

    for idx, parsed in enumerate(parsed_rows):
        raw_dt = parsed["return_date_raw"]
        return_date_str = _convert_to_us_date(raw_dt)
        us_date = _parse_yyyy_mm_dd(return_date_str)
        all_us_dates.append(us_date)

        row_dict = {
            "project_id": project.id,
            "country": country,
            "source_file_id": source.id,
            "source_row_no": idx + 1,
            "return_date": us_date,
        }
        # Copy all fields except the raw datetime placeholder
        for k, v in parsed.items():
            if k != "return_date_raw":
                row_dict[k] = v
        rows.append(row_dict)

    if rows:
        stmt = pg_insert(AnalysisReturnRow).values(rows)
        stmt = stmt.on_conflict_do_update(
            constraint="uq_return_event",
            set_={
                "return_date": stmt.excluded.return_date,
                "license_plate_number": stmt.excluded.license_plate_number,
                "status": stmt.excluded.status,
                "reason": stmt.excluded.reason,
                "detailed_disposition": stmt.excluded.detailed_disposition,
                "source_file_id": stmt.excluded.source_file_id,
                "source_row_no": stmt.excluded.source_row_no,
                "asin": stmt.excluded.asin,
                "fnsku": stmt.excluded.fnsku,
                "product_name": stmt.excluded.product_name,
                "quantity": stmt.excluded.quantity,
                "fulfillment_center_id": stmt.excluded.fulfillment_center_id,
                "original_return_datetime": stmt.excluded.original_return_datetime,
                "customer_comments": stmt.excluded.customer_comments,
                "raw_row": stmt.excluded.raw_row,
            },
        )
        db.execute(stmt)

    source.row_count_total = len(rows)
    source.row_count_included = len(rows)
    source.ingestion_status = "success"

    _replace_current_pointer(db, source)
    source.is_current = True
    source.superseded_at = None
    db.flush()

    # Write upload log（使用本地时间）
    log_date = _resolve_upload_date(now)
    _write_upload_log(
        db,
        project_id=project.id,
        report_type="return_report",
        country=country,
        upload_date=log_date,
        has_real_data=len(rows) > 0,
        row_count=len(rows),
        source_file_id=source.id,
        original_filename=file_path.name,
    )

    db.commit()

    return {
        "success": True,
        "source_id": source.id,
        "row_count": len(rows),
        "report_start_date": min(all_us_dates).isoformat() if all_us_dates else upload_date.isoformat(),
        "report_end_date": max(all_us_dates).isoformat() if all_us_dates else upload_date.isoformat(),
    }


def _convert_to_us_date(iso_datetime) -> str:
    """Convert a UTC-aware datetime to PT date string (先转时区再取日期)."""
    if iso_datetime.tzinfo is None:
        iso_datetime = iso_datetime.replace(tzinfo=UTC)
    us_dt = iso_datetime.astimezone(PT_TIMEZONE)
    return us_dt.strftime("%Y-%m-%d")


# ─── Sales report ─────────────────────────────────────────────────────────────


def _persist_sales_report_marker(
    db: Session,
    file_path: Path,
    project: Project,
    country: str,
    file_id: str,
    extension: str,
    project_slug: str,
    now: datetime,
) -> dict[str, Any]:
    """Write a marker source file when sales report has no valid rows.

    Marker rows use upload_marker_date (upload status date) exclusively.
    report_date is left NULL so marker never pollutes business date range.
    """
    target_date = now.date()
    version = _next_version(
        db, project_id=project.id, report_type="sales_report", country=country,
        period_start_date=target_date, period_end_date=target_date,
    )
    logical_filename = _build_logical_filename(
        project_slug, "sales_report", target_date, target_date, now, version, extension
    )
    storage_key = _build_storage_key(
        project_slug, "sales_report", target_date, target_date, version, file_id
    )
    source = AnalysisSourceFile(
        project_id=project.id,
        report_type="sales_report",
        country=country,
        report_date=None,  # 无业务日期
        period_start_date=target_date,
        period_end_date=target_date,
        snapshot_at=None,
        version=version,
        is_current=True,
        superseded_at=None,
        upload_file_id=file_id,
        upload_file_path=str(file_path),
        original_filename=file_path.name,
        stored_filename=file_id,
        logical_filename=logical_filename,
        storage_key=storage_key,
        file_size_bytes=file_path.stat().st_size,
        file_sha256=_sha256_file(file_path),
        ingestion_status="success",
        row_count_total=0,
        row_count_included=0,
    )
    db.add(source)
    db.flush()
    _replace_current_pointer(db, source)
    source.superseded_at = None
    upload_date = _resolve_upload_date(now)
    _write_upload_log(
        db,
        project_id=project.id,
        report_type="sales_report",
        country=country,
        upload_date=upload_date,
        has_real_data=False,
        row_count=0,
        source_file_id=source.id,
        original_filename=file_path.name,
    )
    db.commit()
    return {
        "success": True,
        "source_id": source.id,
        "row_count": 0,
        "report_start_date": target_date.isoformat(),
        "report_end_date": target_date.isoformat(),
    }


def _persist_sales_report(
    db: Session,
    file_path: Path,
    project: Project,
    country: str,
    file_id: str,
    extension: str,
    project_slug: str,
    known_skus: set[str],
    known_asins: set[str],
    now: datetime,
) -> dict[str, Any]:
    rows, total, _ = _parse_sales_rows(file_path, 0, country=country)
    if not rows:
        # 无有效行 → 写入标记记录，确保 RPA 状态显示"已上传（无数据）"
        return _persist_sales_report_marker(
            db, file_path, project, country, file_id, extension,
            project_slug, now,
        )

    # Group by purchase date
    grouped: dict[date, list[dict]] = {}
    for row in rows:
        pt = row.get("purchase_date_pt")
        if isinstance(pt, date):
            grouped.setdefault(pt, []).append(row)

    file_size = file_path.stat().st_size
    sha = _sha256_file(file_path)
    latest_id = None

    for report_date in sorted(grouped):
        version = _next_version(
            db, project_id=project.id, report_type="sales_report", country=country,
            period_start_date=report_date, period_end_date=report_date,
        )
        logical_filename = _build_logical_filename(
            project_slug, "sales_report", report_date, report_date, now, version, extension
        )
        storage_key = _build_storage_key(
            project_slug, "sales_report", report_date, report_date, version, file_id
        )

        source = AnalysisSourceFile(
            project_id=project.id,
            report_type="sales_report",
            country=country,
            report_date=report_date,
            period_start_date=report_date,
            period_end_date=report_date,
            snapshot_at=None,
            version=version,
            is_current=False,
            superseded_at=None,
            upload_file_id=file_id,
            upload_file_path=str(file_path),
            original_filename=file_path.name,
            stored_filename=file_id,
            logical_filename=logical_filename,
            storage_key=storage_key,
            file_size_bytes=file_size,
            file_sha256=sha,
            ingestion_status="running",
            row_count_total=0,
            row_count_included=0,
        )
        db.add(source)
        db.flush()

        daily_rows = grouped[report_date]
        included = 0
        payloads = []
        for row in daily_rows:
            item = dict(row)
            item["source_file_id"] = source.id
            if item.get("is_counted_sales"):
                included += 1
            payloads.append(item)

        if payloads:
            db.execute(insert(AnalysisSalesOrderRow), payloads)

        source.row_count_total = len(payloads)
        source.row_count_included = included
        source.ingestion_status = "success"

        _replace_current_pointer(db, source)
        source.is_current = True
        source.superseded_at = None
        db.flush()
        latest_id = source.id

    upload_date = _resolve_upload_date(now)
    _write_upload_log(
        db,
        project_id=project.id,
        report_type="sales_report",
        country=country,
        upload_date=upload_date,
        has_real_data=total > 0,
        row_count=total,
        source_file_id=latest_id,
        original_filename=file_path.name,
    )
    db.commit()
    dates = sorted(grouped)
    return {
        "success": True,
        "source_id": latest_id,
        "row_count": total,
        "message": f"销售报表已按购买日期拆分为 {len(dates)} 个日期入库",
    }


# ─── Row parsers ──────────────────────────────────────────────────────────────


def _parse_and_insert_rows(
    db: Session,
    path: Path,
    source_id: int,
    report_type: str,
    known_skus: set[str],
    known_asins: set[str],
    project_name: str = "",
    country: str = "",
) -> tuple[int, int]:
    if report_type == "business_report":
        rows, total, included = _parse_business_rows(path, source_id)
        if rows:
            db.execute(insert(AnalysisBusinessRow), rows)
        return total, included

    if report_type == "payment_report":
        df = read_payment_report_dataframe(path, country=country or "US")
        rows, total, included = _parse_payment_rows(df, source_id, known_skus, known_asins)
        if rows:
            db.execute(insert(AnalysisPaymentRow), rows)
        return total, included

    if report_type == AD_PRODUCT_REPORT:
        rows, total, included = _parse_ad_rows(path, source_id, known_skus, known_asins)
        if rows:
            db.execute(insert(AnalysisAdProductRow), rows)
        return total, included

    if report_type == "inventory_report":
        rows, total, included = _parse_inventory_rows(path, source_id)
        _validate_inventory(rows, project_name=project_name, country=country, known_skus=known_skus, known_asins=known_asins)
        if rows:
            db.execute(insert(InventorySnapshotRow), rows)
        return total, included

    return 0, 0


# ─── Sales report dates helper ────────────────────────────────────────────────


def _extract_sales_report_dates(path: Path, country: str) -> list[date]:
    df = pd.read_csv(path, sep="\t", encoding="utf-8-sig", nrows=200)
    if "purchase-date" not in df.columns:
        return []
    dates = pd.to_datetime(df["purchase-date"], errors="coerce").dropna()
    if dates.empty:
        return []
    return list(dates.dt.date.unique())


# ─── File system helpers ──────────────────────────────────────────────────────


def _move_to_processed(file_path: Path) -> None:
    processed_dir = file_path.parent / PROCESSED_SUBDIR
    processed_dir.mkdir(parents=True, exist_ok=True)
    dest = processed_dir / file_path.name
    if dest.exists():
        stem = file_path.stem
        suffix = file_path.suffix
        counter = 1
        while dest.exists():
            dest = processed_dir / f"{stem}_{counter}{suffix}"
            counter += 1
    shutil.move(str(file_path), str(dest))


# ─── DB helpers ──────────────────────────────────────────────────────────────


def _get_project_by_name(db: Session, project_name: str) -> Project:
    row = db.execute(
        select(Project).where(Project.project_name == project_name.strip())
    ).scalars().first()
    if row is None:
        raise ValueError(f"Project not found: {project_name}")
    return row


def _load_project_product_mapping(
    db: Session, project_name: str, country: str
) -> tuple[set[str], set[str]]:
    rows = db.execute(
        select(ProductCost.sku, ProductCost.asin).where(
            ProductCost.project_id == Project.id,
            Project.project_name == project_name,
            ProductCost.is_active.is_(True),
            ProductCost.country == country,
        )
    ).all()
    # Use normalize_sku (uppercase + strip spaces) to match backend validation logic
    skus = {_normalize_sku(s) for s, _ in rows if _normalize_sku(s)}
    asins = {_normalize_asin(a) for _, a in rows if _normalize_asin(a)}
    return skus, asins


# ─── Processor-specific helpers (not shared) ────────────────────────────────


def _generate_file_id(original_filename: str) -> str:
    safe_name = re.sub(r"[^\w.\-]", "_", original_filename)
    return f"{uuid.uuid4().hex}_{safe_name}"


_shared_build_logical_filename = _build_logical_filename


def _build_logical_filename(
    project_slug: str,
    report_type: str,
    period_start: date | None,
    period_end: date | None,
    snapshot_at: datetime,
    version: int,
    extension: str,
) -> str:
    """Adapter: positional args → keyword-only args of shared build_logical_filename."""
    return _shared_build_logical_filename(
        project_slug=project_slug,
        report_type=report_type,
        period_start_date=period_start,
        period_end_date=period_end,
        snapshot_at=snapshot_at,
        version=version,
        extension=extension,
    )


def _build_storage_key(
    project_slug: str,
    report_type: str,
    period_start: date | None,
    period_end: date | None,
    version: int,
    file_id: str,
) -> str:
    if report_type == "inventory_report":
        return f"analysis/{project_slug}/{report_type}/snapshot/v{version}/{file_id}"
    if period_start is None or period_end is None:
        raise ValueError(f"Missing period for {report_type}")
    return (
        f"analysis/{project_slug}/{report_type}/"
        f"{period_start.strftime('%Y%m%d')}_{period_end.strftime('%Y%m%d')}/"
        f"v{version}/{file_id}"
    )


def _build_month_date(year_text: str, month_text: str, day_text: str) -> date | None:
    month = _MONTH_MAP.get(str(month_text).strip().lower())
    if month is None:
        return None
    try:
        return date(int(year_text), month, int(day_text))
    except ValueError:
        return None


def _parse_payment_period_from_filename(value: str | None) -> tuple[date, date] | None:
    text = str(value or "").strip()
    if not text:
        return None

    match = _PAYMENT_FILENAME_RE.search(text)
    if match is None:
        return None

    start_date = _build_month_date(match.group(1), match.group(2), match.group(3))
    end_date = _build_month_date(match.group(4), match.group(5), match.group(6))
    if start_date is None or end_date is None or start_date > end_date:
        return None
    return start_date, end_date


def _find_sha256_duplicates(db: Session, file_sha256: str) -> list[dict]:
    """Find existing records with same SHA-256 (autoReportUpload version).

    Returns list of dicts with project_id, report_type, country, source_id, row_count_total.
    """
    rows = db.execute(
        select(AnalysisSourceFile).where(
            AnalysisSourceFile.file_sha256 == file_sha256
        )
    ).scalars().all()

    return [
        {
            "project_id": row.project_id,
            "report_type": row.report_type,
            "country": row.country,
            "source_id": row.id,
            "row_count_total": row.row_count_total,
        }
        for row in rows
    ]
