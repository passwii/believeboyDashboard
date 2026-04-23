"""
File processor: recognize → persist to DB → move file.
Adapted from backend/app/services/product_analysis_source_service.py
"""

from __future__ import annotations

import hashlib
import re
import shutil
import uuid
from datetime import UTC, date, datetime

PT_TIMEZONE = __import__("zoneinfo", fromlist=["ZoneInfo"]).ZoneInfo("America/Los_Angeles")
COUNTRY_TIMEZONE = {
    "US": PT_TIMEZONE,
    "CA": PT_TIMEZONE,
    "MX": PT_TIMEZONE,
    "UK": __import__("zoneinfo", fromlist=["ZoneInfo"]).ZoneInfo("Europe/London"),
    "DE": __import__("zoneinfo", fromlist=["ZoneInfo"]).ZoneInfo("Europe/Berlin"),
    "FR": __import__("zoneinfo", fromlist=["ZoneInfo"]).ZoneInfo("Europe/Paris"),
    "IT": __import__("zoneinfo", fromlist=["ZoneInfo"]).ZoneInfo("Europe/Rome"),
    "ES": __import__("zoneinfo", fromlist=["ZoneInfo"]).ZoneInfo("Europe/Madrid"),
    "JP": __import__("zoneinfo", fromlist=["ZoneInfo"]).ZoneInfo("Asia/Tokyo"),
    "AU": __import__("zoneinfo", fromlist=["ZoneInfo"]).ZoneInfo("Australia/Sydney"),
    "IN": __import__("zoneinfo", fromlist=["ZoneInfo"]).ZoneInfo("Asia/Kolkata"),
}
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any
import warnings

import pandas as pd
from slugify import slugify
from sqlalchemy import func, insert, select, update as sa_update
from sqlalchemy.orm import Session

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
    _read_payment_report as _read_payment_report_impl,
    _read_csv_with_encoding_fallback as _recog_csv,
)

def _resolve_upload_date(now: datetime) -> date:
    """返回当前本地日期作为 upload_log 日期。"""
    return now.date()

OPENPYXL_MISSING_DEFAULT_STYLE_WARNING = (
    r"Workbook contains no default style, apply openpyxl's default"
)

SCOPE_INCLUDED = "included_product"
SCOPE_EXCLUDED_UNMAPPED = "excluded_unmapped"
PERIODIC_REPORT_TYPES = {"business_report", "payment_report", AD_PRODUCT_REPORT, "sales_report", "inventory_report", "return_report"}


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
    ):
        self.skipped = skipped
        self.success = success
        self.report_type = report_type
        self.reason = reason
        self.source_id = source_id
        self.row_count = row_count
        self.error = error

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
    # 1. Recognize
    result = recognize_file(db, file_path, original_filename=file_path.name)
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

    if not outcome.get("success"):
        error_msg = str(outcome.get("error", ""))
        is_duplicate = (
            "UniqueViolation" in error_msg
            or "duplicate key" in error_msg.lower()
            or "uq_return_record_key" in error_msg
        )
        if is_duplicate:
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

    return ProcessResult(
        success=True,
        report_type=result.report_type,
        source_id=outcome.get("source_id"),
        row_count=outcome.get("row_count", 0),
        reason=(
            f"{outcome.get('report_start_date', '')}"
            f"{'–' if outcome.get('report_start_date') and outcome.get('report_end_date') else ''}"
            f"{outcome.get('report_end_date', '')}"
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
    project = _get_project_by_name(db, project_name)
    report_type = result.report_type
    country = result.country or "US"
    now = datetime.now()

    known_skus, known_asins = _load_project_product_mapping(db, project_name, country)

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
    version = _next_version(
        db, project.id, report_type, country, period_start, period_end
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

    try:
        total, included = _parse_and_insert_rows(
            db, file_path, source.id, report_type, known_skus, known_asins
        )
        source.row_count_total = total
        source.row_count_included = included
        source.ingestion_status = "success"

        _replace_current_pointer(db, source)
        source.is_current = True
        source.superseded_at = None
        db.flush()

        # Write upload log（使用本地时间）
        upload_date = _resolve_upload_date(now)
        _write_upload_log(db, project.id, report_type, country, upload_date, total > 0, total, source.id, file_path.name)

        db.commit()
        return {"success": True, "source_id": source.id, "row_count": total}
    except Exception as exc:  # noqa: BLE001
        source.ingestion_status = "failed"
        source.ingestion_error = str(exc)[:4000]
        db.commit()
        return {"success": False, "error": str(exc)}


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
    version = _next_version(db, project.id, "return_report", country, upload_date, upload_date)
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

    # Parse return rows
    df = _recog_csv(file_path, sep="\t")
    df.columns = [str(c).strip() for c in df.columns]

    required = ["return-date", "sku"]
    missing = [c for c in required if c not in df.columns]
    if missing:
        source.ingestion_status = "failed"
        source.ingestion_error = f"缺少必要字段: {missing}"
        db.commit()
        return {"success": False, "error": f"缺少必要字段: {missing}"}

    seen_keys: set[tuple] = set()
    rows: list[dict] = []
    all_us_dates: list[date] = []

    for idx, row in df.iterrows():
        original_dt_str = str(row.get("return-date", "")).strip()
        original_dt = _parse_iso_datetime(original_dt_str)
        if original_dt is None:
            continue

        return_date_str = _convert_to_us_date(original_dt)
        us_date = _parse_yyyy_mm_dd(return_date_str)
        all_us_dates.append(us_date)
        order_id = str(row.get("order-id", "")).strip()
        sku = str(row.get("sku", "")).strip()
        asin = str(row.get("asin", "")) if pd.notna(row.get("asin")) else None
        fnsku = str(row.get("fnsku", "")) if pd.notna(row.get("fnsku")) else None
        product_name = str(row.get("product-name", "")) if pd.notna(row.get("product-name")) else None
        quantity = int(row.get("quantity", 1)) if pd.notna(row.get("quantity")) else 1
        fulfillment_center_id = (
            str(row.get("fulfillment-center-id", ""))
            if pd.notna(row.get("fulfillment-center-id"))
            else None
        )
        detailed_disposition = str(row.get("detailed-disposition", "")).strip()
        reason = str(row.get("reason", "")).strip()
        status = str(row.get("status", "")).strip()
        license_plate = (
            str(row.get("license-plate-number", ""))
            if pd.notna(row.get("license-plate-number"))
            else None
        )
        customer_comments = (
            str(row.get("customer-comments", ""))
            if pd.notna(row.get("customer-comments"))
            else ""
        )

        dedupe_key = (
            project.id, country, order_id, sku, asin, fnsku,
            product_name, quantity, fulfillment_center_id,
            detailed_disposition, reason, status, license_plate,
            original_dt_str, customer_comments,
        )
        if dedupe_key in seen_keys:
            continue
        seen_keys.add(dedupe_key)

        rows.append({
            "source_file_id": source.id,
            "source_row_no": idx + 1,
            "return_date": us_date,
            "order_id": order_id,
            "sku": sku,
            "asin": asin,
            "fnsku": fnsku,
            "product_name": product_name,
            "quantity": quantity,
            "fulfillment_center_id": fulfillment_center_id,
            "detailed_disposition": detailed_disposition,
            "reason": reason,
            "status": status,
            "license_plate_number": license_plate,
            "original_return_datetime": original_dt_str,
            "customer_comments": customer_comments if customer_comments else None,
            "raw_row": _to_raw_row(row.to_dict()),
        })

    # Insert rows
    if rows:
        db.execute(insert(AnalysisReturnRow), rows)

    source.row_count_total = len(rows)
    source.row_count_included = len(rows)
    source.ingestion_status = "success"

    _replace_current_pointer(db, source)
    source.is_current = True
    source.superseded_at = None
    db.flush()

    # Write upload log（使用本地时间）
    log_date = _resolve_upload_date(now)
    _write_upload_log(db, project.id, "return_report", country, log_date, len(rows) > 0, len(rows), source.id, file_path.name)

    db.commit()

    return {
        "success": True,
        "source_id": source.id,
        "row_count": len(rows),
        "report_start_date": min(all_us_dates).isoformat() if all_us_dates else upload_date.isoformat(),
        "report_end_date": max(all_us_dates).isoformat() if all_us_dates else upload_date.isoformat(),
    }


def _parse_iso_datetime(date_str: str):
    if not date_str or pd.isna(date_str):
        return None
    parsed = pd.to_datetime(date_str, errors="coerce", utc=True)
    if parsed is None or pd.isna(parsed):
        return None
    return parsed.to_pydatetime()


def _convert_to_us_date(iso_datetime) -> str:
    """Convert a UTC-aware datetime to PT date string (先转时区再取日期)."""
    if iso_datetime.tzinfo is None:
        iso_datetime = iso_datetime.replace(tzinfo=UTC)
    us_dt = iso_datetime.astimezone(PT_TIMEZONE)
    return us_dt.strftime("%Y-%m-%d")


def _split_customer_comments(comment: str) -> list[str]:
    if not comment or pd.isna(comment):
        return []
    cleaned = str(comment).replace("&#39;", "'").replace("&amp;", "&")
    return [p.strip() for p in cleaned.split("|") if p.strip()]


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
        db, project.id, "sales_report", country, target_date, target_date
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

    # 上传时刻的日期，用于标记"今日已上传"状态
    file_upload_date = now.date()

    for report_date in sorted(grouped):
        version = _next_version(
            db, project.id, "sales_report", country, report_date, report_date
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
) -> tuple[int, int]:
    if report_type == "business_report":
        rows = _parse_business_rows(path, source_id)
        if rows:
            db.execute(insert(AnalysisBusinessRow), rows)
        return len(rows), len(rows)

    if report_type == "payment_report":
        df = _read_payment_report_impl(path)
        rows, total, included = _parse_payment_rows_df(df, source_id, known_skus, known_asins)
        if rows:
            db.execute(insert(AnalysisPaymentRow), rows)
        return total, included

    if report_type == AD_PRODUCT_REPORT:
        rows, total, included = _parse_ad_rows(path, source_id, known_skus, known_asins)
        if rows:
            db.execute(insert(AnalysisAdProductRow), rows)
        return total, included

    if report_type == "inventory_report":
        rows = _parse_inventory_rows(path, source_id)
        _validate_inventory(rows, known_skus, known_asins)
        if rows:
            db.execute(insert(InventorySnapshotRow), rows)
        return len(rows), len(rows)

    return 0, 0



def _read_excel_no_warning(path: Path) -> pd.DataFrame:
    with warnings.catch_warnings():
        warnings.filterwarnings(
            "ignore",
            message=OPENPYXL_MISSING_DEFAULT_STYLE_WARNING,
            category=UserWarning,
        )
        return pd.read_excel(path, engine="openpyxl")


def _parse_business_rows(path: Path, source_file_id: int) -> list[dict]:
    df = pd.read_csv(path, encoding="utf-8-sig")
    df.columns = [str(c).strip() for c in df.columns]

    asin_col = next(
        (c for c in ["（子）ASIN", "(子)ASIN", "子ASIN", "ASIN"] if c in df.columns), None
    )
    page_col = next(
        (c for c in ["页面浏览量 - 总计", "页面浏览量-总计", "Page Views - Total"] if c in df.columns),
        None,
    )
    units_col = next(
        (c for c in ["已订购商品数量", "Ordered Product Sales Units", "Units Ordered"] if c in df.columns),
        None,
    )
    sess_col = next(
        (c for c in ["会话数 - 总计", "会话数-总计", "Sessions - Total"] if c in df.columns),
        None,
    )
    sales_col = next(
        (c for c in ["已订购商品销售额", "Ordered Product Sales", "Ordered Product Sales Amount"]
         if c in df.columns),
        None,
    )

    if not asin_col:
        raise ValueError("Business report missing ASIN column")

    payloads = []
    for idx, row in df.iterrows():
        amount = _to_decimal_with_currency(row.get(sales_col))
        payloads.append({
            "source_file_id": source_file_id,
            "source_row_no": idx + 1,
            "asin": _normalize_text(row.get(asin_col)),
            "page_views": _to_int(row.get(page_col)),
            "units_ordered": _to_int(row.get(units_col)),
            "sessions": _to_int(row.get(sess_col)),
            "ordered_sales_amount": amount,
            "raw_row": _to_raw_row(row.to_dict()),
        })
    return payloads


def _parse_payment_rows_df(
    df: pd.DataFrame,
    source_file_id: int,
    known_skus: set[str],
    known_asins: set[str],
) -> tuple[list[dict], int, int]:
    numeric_cols = [
        "quantity", "product sales", "shipping credits",
        "promotional rebates", "other", "selling fees", "fba fees",
    ]
    for col in numeric_cols:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0)

    asin_col = "asin" if "asin" in df.columns else ("ASIN" if "ASIN" in df.columns else None)
    payloads = []
    included = 0

    for idx, row in df.iterrows():
        sku = _normalize_text(row.get("sku")) or ""
        asin_val = _normalize_text(row.get(asin_col)) if asin_col else None
        norm_sku = _normalize_identity(sku)
        norm_asin = _normalize_identity(asin_val) if asin_val else ""
        scope = SCOPE_INCLUDED if (norm_sku in known_skus or norm_asin in known_asins) else SCOPE_EXCLUDED_UNMAPPED
        if scope == SCOPE_INCLUDED:
            included += 1

        total = (
            _to_decimal(row.get("total"))
            if "total" in df.columns
            else sum(_to_decimal(row.get(c)) for c in numeric_cols if c in df.columns)
        )

        payloads.append({
            "source_file_id": source_file_id,
            "source_row_no": idx + 1,
            "transaction_at": _parse_transaction_at(row),
            "transaction_type": _normalize_text(row.get("type")) or "UNKNOWN",
            "order_id": _normalize_text(
                row.get("order id") if "order id" in df.columns else None
            ),
            "sku": sku or None,
            "asin": asin_val,
            "quantity": _to_int(row.get("quantity")),
            "product_sales": _to_decimal(row.get("product sales")),
            "shipping_credits": _to_decimal(row.get("shipping credits")),
            "promotional_rebates": _to_decimal(row.get("promotional rebates")),
            "other_amount": _to_decimal(row.get("other")),
            "selling_fees": _to_decimal(row.get("selling fees")),
            "fba_fees": _to_decimal(row.get("fba fees")),
            "total_amount": total,
            "scope_status": scope,
            "scope_reason": None if scope == SCOPE_INCLUDED else "sku/asin not in product_costs",
            "raw_row": _to_raw_row(row.to_dict()),
        })

    return payloads, len(payloads), included


def _parse_ad_rows(
    path: Path,
    source_file_id: int,
    known_skus: set[str],
    known_asins: set[str],
) -> tuple[list[dict], int, int]:
    df = _read_excel_no_warning(path)
    df.columns = [str(c).strip() for c in df.columns]

    required = ["广告SKU", "展示量", "点击量", "花费", "7天总销售额", "7天总销售量(#)"]
    if any(c not in df.columns for c in required):
        raise ValueError(f"Ad report missing required columns: {required}")

    asin_col = "广告ASIN" if "广告ASIN" in df.columns else ("ASIN" if "ASIN" in df.columns else None)
    payloads = []
    included = 0

    for idx, row in df.iterrows():
        sku = _normalize_text(row.get("广告SKU")) or ""
        asin_val = _normalize_text(row.get(asin_col)) if asin_col else None
        norm_sku = _normalize_identity(sku)
        norm_asin = _normalize_identity(asin_val) if asin_val else ""
        scope = SCOPE_INCLUDED if (norm_sku in known_skus or norm_asin in known_asins) else SCOPE_EXCLUDED_UNMAPPED
        if scope == SCOPE_INCLUDED:
            included += 1

        payloads.append({
            "source_file_id": source_file_id,
            "source_row_no": idx + 1,
            "sku": sku or None,
            "asin": asin_val,
            "impressions": _to_int(row.get("展示量")),
            "clicks": _to_int(row.get("点击量")),
            "spend": _to_decimal(row.get("花费")),
            "sales_7d": _to_decimal(row.get("7天总销售额")),
            "orders_7d": _to_int(row.get("7天总销售量(#)")),
            "scope_status": scope,
            "scope_reason": None if scope == SCOPE_INCLUDED else "sku/asin not in product_costs",
            "raw_row": _to_raw_row(row.to_dict()),
        })

    return payloads, len(payloads), included


def _parse_inventory_rows(path: Path, source_file_id: int) -> list[dict]:
    df = pd.read_csv(path, sep="\t", encoding="utf-8-sig")
    df.columns = [str(c).strip() for c in df.columns]

    keep = [
        "sku", "asin", "available",
        "inv-age-0-to-90-days", "inv-age-91-to-180-days",
        "inv-age-181-to-270-days", "inv-age-271-to-365-days",
        "inv-age-365-plus-days", "recommended-action",
    ]
    if not any(c in df.columns for c in keep):
        raise ValueError("Inventory report missing required columns")

    payloads = []
    for idx, row in df.iterrows():
        a90 = _to_int(row.get("inv-age-0-to-90-days"))
        a91 = _to_int(row.get("inv-age-91-to-180-days"))
        a181 = _to_int(row.get("inv-age-181-to-270-days"))
        a271 = _to_int(row.get("inv-age-271-to-365-days"))
        a365 = _to_int(row.get("inv-age-365-plus-days"))
        avail = _to_int(row.get("available"))

        stock_status = "out_of_stock" if avail <= 0 else "in_stock"
        aging_status = "over_aged" if a365 > 0 else ("aging" if a91 + a181 + a271 > 0 else "fresh")

        payloads.append({
            "source_file_id": source_file_id,
            "source_row_no": idx + 1,
            "sku": _normalize_text(row.get("sku")),
            "asin": _normalize_text(row.get("asin")),
            "available_qty": avail,
            "age_0_90_qty": a90,
            "age_91_180_qty": a91,
            "age_181_270_qty": a181,
            "age_271_365_qty": a271,
            "age_365_plus_qty": a365,
            "recommended_action": _normalize_text(row.get("recommended-action")),
            "stock_status": stock_status,
            "aging_status": aging_status,
            "raw_row": _to_raw_row(row.to_dict()),
        })
    return payloads


def _parse_sales_rows(
    path: Path,
    source_file_id: int,
    *,
    country: str = "US",
) -> tuple[list[dict], int, int]:
    df = pd.read_csv(path, sep="\t", encoding="utf-8-sig")
    df.columns = [str(c).strip() for c in df.columns]

    required = [
        "amazon-order-id", "purchase-date", "order-status",
        "sku", "asin", "quantity", "item-price",
    ]
    if any(c not in df.columns for c in required):
        raise ValueError(f"Sales report missing required columns: {required}")

    local_tz = COUNTRY_TIMEZONE.get(country, PT_TIMEZONE)
    as_of = datetime.now(UTC).astimezone(local_tz).date()
    payloads = []
    included = 0

    for idx, row in df.iterrows():
        order_id = _normalize_text(row.get("amazon-order-id"))
        parsed_utc = pd.to_datetime(row.get("purchase-date"), errors="coerce", utc=True)
        if not order_id or pd.isna(parsed_utc):
            continue

        utc_aware = parsed_utc.to_pydatetime()
        local_aware = utc_aware.astimezone(local_tz)
        purchase_at_pt = local_aware.replace(tzinfo=None)
        purchase_date_pt = local_aware.date()
        status_text = (_normalize_text(row.get("order-status")) or "").strip().lower()

        if status_text in {"cancelled", "canceled"}:
            is_counted = False
        elif (as_of - purchase_date_pt).days <= 2:
            is_counted = status_text in {"pending", "unshipped", "shipped"}
        else:
            is_counted = status_text == "shipped"

        if is_counted:
            included += 1

        payloads.append({
            "source_file_id": source_file_id,
            "source_row_no": idx + 1,
            "amazon_order_id": order_id,
            "purchase_at_utc": utc_aware,
            "purchase_at_pt": purchase_at_pt,
            "purchase_date_pt": purchase_date_pt,
            "order_status": status_text.title(),
            "sku": _normalize_text(row.get("sku")),
            "asin": _normalize_text(row.get("asin")),
            "quantity": _to_int(row.get("quantity")),
            "item_price": _to_decimal(row.get("item-price")),
            "currency": _normalize_text(row.get("currency")),
            "is_counted_sales": is_counted,
            "status_rule_version": 1,
            "raw_row": _to_raw_row(row.to_dict()),
        })

    return payloads, len(payloads), included


def _extract_sales_report_dates(path: Path, country: str) -> list[date]:
    df = pd.read_csv(path, sep="\t", encoding="utf-8-sig", nrows=200)
    if "purchase-date" not in df.columns:
        return []
    dates = pd.to_datetime(df["purchase-date"], errors="coerce").dropna()
    if dates.empty:
        return []
    return list(dates.dt.date.unique())


def _validate_inventory(
    rows: list[dict],
    known_skus: set[str],
    known_asins: set[str],
) -> None:
    if not known_skus and not known_asins:
        return
    identifiable = matched = 0
    for row in rows:
        sku = _normalize_identity(row.get("sku") or "")
        asin = _normalize_identity(row.get("asin") or "")
        if not sku and not asin:
            continue
        identifiable += 1
        if sku in known_skus or asin in known_asins:
            matched += 1

    if identifiable == 0:
        raise ValueError("Inventory report: no identifiable SKU/ASIN rows found")
    ratio = matched / identifiable if identifiable else 0
    if matched == 0 or (identifiable >= 5 and ratio < 0.6):
        raise ValueError(
            f"Inventory validation failed: {matched}/{identifiable} rows matched "
            f"({ratio:.0%}); expected ≥60%. Confirm this file belongs to the project."
        )


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
            ProductCost.project_name == project_name,
            ProductCost.is_active.is_(True),
            ProductCost.country == country,
        )
    ).all()
    skus = {_normalize_identity(s) for s, _ in rows if _normalize_identity(s)}
    asins = {_normalize_identity(a) for _, a in rows if _normalize_identity(a)}
    return skus, asins


def _parse_yyyy_mm_dd(value: str) -> date:
    return datetime.strptime(value.strip(), "%Y-%m-%d").date()


def _next_version(
    db: Session,
    project_id: int,
    report_type: str,
    country: str,
    period_start: date | None,
    period_end: date | None,
) -> int:
    stmt = select(func.max(AnalysisSourceFile.version)).where(
        AnalysisSourceFile.project_id == project_id,
        AnalysisSourceFile.report_type == report_type,
        AnalysisSourceFile.country == country,
    )
    if period_start is not None and period_end is not None:
        stmt = stmt.where(
            AnalysisSourceFile.period_start_date == period_start,
            AnalysisSourceFile.period_end_date == period_end,
        )
    val = db.execute(stmt).scalar_one_or_none()
    return int(val or 0) + 1


def _replace_current_pointer(db: Session, source: AnalysisSourceFile) -> None:
    conditions = [
        AnalysisSourceFile.project_id == source.project_id,
        AnalysisSourceFile.report_type == source.report_type,
        AnalysisSourceFile.country == source.country,
        AnalysisSourceFile.id != source.id,
        AnalysisSourceFile.is_current.is_(True),
    ]
    if source.report_type in PERIODIC_REPORT_TYPES:
        conditions.extend([
            AnalysisSourceFile.period_start_date == source.period_start_date,
            AnalysisSourceFile.period_end_date == source.period_end_date,
        ])
    db.execute(
        sa_update(AnalysisSourceFile)
        .where(*conditions)
        .values(is_current=False, superseded_at=datetime.now())
    )


# ─── Utility helpers ──────────────────────────────────────────────────────────


def _normalize_text(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text or text.lower() == "nan":
        return None
    return text


def _normalize_identity(value: object) -> str:
    t = _normalize_text(value)
    return t.upper() if t else ""


def _to_int(value: object) -> int:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return 0
    try:
        return int(float(str(value).strip() or "0"))
    except (TypeError, ValueError):
        return 0


def _to_decimal(value: object) -> Decimal:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return Decimal("0")
    try:
        text = str(value).strip().replace(",", "")
        return Decimal(text) if text else Decimal("0")
    except (InvalidOperation, ValueError):
        return Decimal("0")


def _to_decimal_with_currency(value: object) -> Decimal:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return Decimal("0")
    text = re.sub(r"[^0-9.\-]", "", str(value))
    if not text:
        return Decimal("0")
    try:
        return Decimal(text)
    except InvalidOperation:
        return Decimal("0")


def _to_raw_row(row: dict) -> dict:
    payload = {}
    for k, v in row.items():
        text_key = str(k)
        if v is None:
            payload[text_key] = None
            continue
        if isinstance(v, float) and pd.isna(v):
            payload[text_key] = None
            continue
        if hasattr(v, "isoformat"):
            try:
                payload[text_key] = v.isoformat()
                continue
            except TypeError:
                pass
        if isinstance(v, (int, float, bool, str)):
            payload[text_key] = v
        else:
            payload[text_key] = str(v)
    return payload


def _parse_transaction_at(row: pd.Series) -> datetime | None:
    for key in ("date/time", "transaction date", "transaction_date", "date"):
        if key not in row:
            continue
        val = row.get(key)
        if val is None:
            continue
        parsed = pd.to_datetime(val, errors="coerce")
        if pd.isna(parsed):
            continue
        return parsed.to_pydatetime()
    return None


def _generate_file_id(original_filename: str) -> str:
    safe_name = re.sub(r"[^\w.\-]", "_", original_filename)
    return f"{uuid.uuid4().hex}_{safe_name}"


def _project_slug(project_name: str) -> str:
    cleaned = re.sub(r"[\\/:*?\"<>|\x00-\x1f]+", "-", (project_name or "").strip())
    slug = slugify(cleaned) if slugify else cleaned.lower().replace(" ", "-")
    return slug[:80] or "project"


def _build_logical_filename(
    project_slug: str,
    report_type: str,
    period_start: date | None,
    period_end: date | None,
    snapshot_at: datetime,
    version: int,
    extension: str,
) -> str:
    ext = extension if extension.startswith(".") else f".{extension}" if extension else ""
    ts = snapshot_at.strftime("%Y%m%dT%H%M%SZ")
    if report_type == "inventory_report":
        return f"{project_slug}__inventory_report__snapshot-{ts}__v{version}{ext}"
    if period_start is None or period_end is None:
        raise ValueError(f"Missing period for {report_type}")
    return (
        f"{project_slug}__{report_type}__"
        f"{period_start.strftime('%Y%m%d')}_{period_end.strftime('%Y%m%d')}__"
        f"v{version}__{ts}{ext}"
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


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()
