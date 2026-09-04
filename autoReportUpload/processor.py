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
from sqlalchemy import insert, select, update as sa_update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from config import AD_PROCESSED_SUBDIR, PROCESSED_SUBDIR, resolve_project_dir
from models import (
    AnalysisBusinessRow,
    AnalysisPaymentRow,
    AnalysisReturnRow,
    AnalysisSalesOrderRow,
    AnalysisSourceFile,
    InventoryLedgerIngestBatch,
    InventorySnapshotRow,
    ProductCost,
    Project,
    ReportUploadLog,
    AdUploadFile,
)
from recognition import (
    B_TABLE_AD_REPORT_TYPES,
    recognize_file,
    _read_csv_with_encoding_fallback as _recog_csv,
)
import emit_event as _emit_event  # noqa: E402

# Payment report parsing — use locale (single source of truth)
from app.utils.payment_locale import read_payment_report_dataframe

# B-table ad upload pipeline (10 ad subtypes) — single source of truth lives in
# backend/app/services/ad/upload/. autoReportUpload reuses the same persistence
# helpers as the HTTP endpoint, so A-table / C-table / B-table all converge on
# one set of ingest functions.
from app.services.ad.upload import (
    REPORT_SPECS,
    save_ad_upload_scope,
)
from app.services.ad.upload.utils import (
    _read_dataframe as _ad_read_dataframe,
    _prepare_ingest_dataframe as _ad_prepare_df,
    _to_int as _ad_to_int,
    _to_decimal as _ad_to_decimal,
)
from app.utils.country import normalize_country as _normalize_country
from app.utils.recognition import LedgerRecognitionError
from app.utils.parsers import classify_scope

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
    upsert_sales_order_rows as _upsert_sales_order_rows,
)

logger = logging.getLogger(__name__)

# ─── Inventory ledger（库存分类账）独立类型 ────────────────────────────────────
# 两个独立类型由共享后端 recognizer（app.utils.recognition）输出；persistence
# 委托给与 HTTP 路径相同的类型化 ingestion —— app.services.inventory.ledger 的
# ingest_ledger_csv(expected_kind=...)，参考
# backend/app/services/data/upload/persistence.py 的
# inventory_ledger_summary / inventory_ledger_detail 分支。
# 分类账类型绝不落入通用 _persist_single_source（A 表 analysis_source_files）。
LEDGER_KIND_BY_REPORT_TYPE: dict[str, str] = {
    "inventory_ledger_summary": "summary",
    "inventory_ledger_detail": "detail",
}

LEDGER_REPORT_LABELS: dict[str, str] = {
    "inventory_ledger_summary": "库存分类账 · 汇总视图（Summary）",
    "inventory_ledger_detail": "库存分类账 · 明细视图（Detail）",
}

_LEDGER_REPORT_TYPE_BY_KIND: dict[str, str] = {
    "summary": "inventory_ledger_summary",
    "detail": "inventory_ledger_detail",
}

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
        # source_file_id 有 FK 指向 analysis_source_files.id（alembic
        # 20260423_103）——只有 A 表重复的 source_id 是有效外键。C 表
        # （ad_upload_files）与 L 表（inventory_ledger_ingest_batch）的
        # source id 不是 analysis_source_files 主键，写进去会在 db.commit()
        # 时抛 IntegrityError（跨天重复重传路径，异常逃出 process_file）。
        # 这两类重复写 None（无 FK 引用），日志行与去重语义保持不变。
        source_file_id = (
            matching_dup["source_id"] if matching_dup.get("table") == "A" else None
        )
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
        report_label: str = "",
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
        self.report_label = report_label
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

    # Digital Employee task tracking (best-effort).
    # _task_id is None for paths that fail before recognition.
    _task_id: str | None = None

    # 1. Recognize
    try:
        result = recognize_file(db, file_path, original_filename=file_path.name, country="US")
    except LedgerRecognitionError as exc:
        # 库存分类账部分签名/冲突是结构化识别失败：转为结构化 ProcessResult，
        # 不抛给调用方（否则轮询模式下 run_cycle 的项目级 catch 每轮中止其余
        # 文件、且该文件永远重试）。文件留在原地，与既有失败路径一致
        # （不入库、不移动）。
        return ProcessResult(
            skipped=False,
            success=False,
            reason=str(exc),
            error=str(exc),
        )
    t1 = time.time()

    if result is None:
        return ProcessResult(skipped=True, reason="未匹配任何报表类型")

    # Chinese report label (ad reports use spec.report_label; A-table uses report_type as-is;
    # 库存分类账使用中文主标签并保留英文对照)
    _report_label = (
        result.spec.report_label
        if result.spec
        else LEDGER_REPORT_LABELS.get(result.report_type, result.report_type)
    )

    # Emit start to Digital Employee (best-effort; 不阻塞主流程)
    _task_id = _emit_event.emit_start(
        db,
        project_name=project_name,
        report_type=result.report_type,
        report_label=_report_label,
        country="US",
        source_file_name=file_path.name,
        row_count=result.row_count_preview,
        detected_date_range=_emit_event._date_range_for(result),
    )

    if result.project_match is None:
        _emit_event.emit_complete(db, task_id=_task_id, success=False, error_message="未匹配到项目信息")
        return ProcessResult(skipped=True, reason="未匹配到项目信息")

    match_status = result.project_match.get("status")
    if match_status != "matched":
        _emit_event.emit_complete(db, task_id=_task_id, success=False, error_message=f"项目匹配状态为 {match_status}")
        return ProcessResult(
            skipped=True,
            report_type=result.report_type,
            report_label=_report_label,
            reason=f"项目匹配状态为 {match_status}：{result.project_match.get('message', '')}",
        )

    matched_project = result.project_match.get("project_name", "")
    if matched_project != project_name:
        _emit_event.emit_complete(db, task_id=_task_id, success=False, error_message=f"项目不一致: {matched_project} != {project_name}")
        return ProcessResult(
            skipped=True,
            report_type=result.report_type,
            report_label=_report_label,
            reason=f"文件匹配项目 '{matched_project}' 与目标项目 '{project_name}' 不一致，跳过",
        )

    if dry_run:
        _emit_event.emit_complete(db, task_id=_task_id, success=True, error_message="dry-run")
        return ProcessResult(
            success=True,
            report_type=result.report_type,
            report_label=_report_label,
            reason=(
                f"[dry-run] 会入库 {result.report_type}，"
                f"行数预估 {result.row_count_preview}，国家 {result.country}"
            ),
        )

    # SHA-256 duplicate detection: exact same file is treated as already handled
    file_sha256 = _sha256_file(file_path)
    duplicates = _find_sha256_duplicates(db, file_sha256)
    if duplicates:
        # Write today's upload log so RPA status grid shows green
        _write_dedup_upload_log(
            db, file_path.name, project_name,
            result.report_type, result.country or "US", duplicates,
        )
        try:
            _move_to_processed(file_path, result.report_type)
        except Exception as exc:
            logger.warning("文件移动失败（DB 已提交）: %s — %s", file_path.name, exc)
        _emit_event.emit_complete(db, task_id=_task_id, success=True, error_message="SHA-256 重复")
        return ProcessResult(
            skipped=True,
            report_type=result.report_type,
            report_label=_report_label,
            reason="SHA-256 重复",
        )

    # 2. Persist to DB
    try:
        outcome = _persist_one_file(db, file_path, project_name, result)
    except Exception as exc:  # noqa: BLE001
        _emit_event.emit_complete(db, task_id=_task_id, success=False, error_message=str(exc))
        return ProcessResult(
            skipped=False,
            success=False,
            report_type=result.report_type,
            report_label=_report_label,
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
            try:
                _move_to_processed(file_path, result.report_type)
            except Exception as exc:
                logger.warning("文件移动失败（DB 已提交）: %s — %s", file_path.name, exc)
            _emit_event.emit_complete(db, task_id=_task_id, success=True, error_message="数据已存在（唯一约束冲突）")
            return ProcessResult(
                skipped=True,
                report_type=result.report_type,
                report_label=_report_label,
                reason="数据已存在（唯一约束冲突），文件已移走",
            )
        _emit_event.emit_complete(db, task_id=_task_id, success=False, error_message=error_msg)
        return ProcessResult(
            skipped=False,
            success=False,
            report_type=result.report_type,
            report_label=_report_label,
            reason="入库失败",
            error=error_msg,
        )

    # 3. Move file to processed/
    try:
        _move_to_processed(file_path, result.report_type)
    except Exception as exc:
        logger.warning("文件移动失败（DB 已提交）: %s — %s", file_path.name, exc)

    total_time = time.time() - t0
    _emit_event.emit_complete(db, task_id=_task_id, success=True)
    return ProcessResult(
        success=True,
        report_type=result.report_type,
        report_label=_report_label,
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

    # B-table ad reports (10 subtypes) have their own persistence path —
    # delegate to the shared ad upload scope helper before touching A-table.
    if report_type in B_TABLE_AD_REPORT_TYPES:
        t1 = time.time()
        known_skus, known_asins = _load_project_product_mapping(db, project_name, country)
        t2 = time.time()
        outcome = _persist_ad_upload_report(
            db=db,
            file_path=file_path,
            project=project,
            country=country,
            result=result,
            known_skus=known_skus,
            known_asins=known_asins,
            now=now,
        )
        outcome["_timing"] = f"setup={t2-t1:.1f}s total={time.time()-t0:.1f}s"
        return outcome

    # 库存分类账独立类型（Summary / Detail）：两个显式分支，各自委托给与 HTTP
    # 路径相同的类型化 ingestion（ingest_ledger_csv + expected_kind），
    # 绝不落入下方通用 _persist_single_source。
    if report_type in LEDGER_KIND_BY_REPORT_TYPE:
        outcome = _persist_inventory_ledger(
            db=db,
            file_path=file_path,
            project=project,
            report_type=report_type,
            country=country,
        )
        outcome["_timing"] = f"total={time.time()-t0:.1f}s"
        return outcome

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


def _persist_ad_upload_report(
    *,
    db: Session,
    file_path: Path,
    project: Project,
    country: str,
    result,
    known_skus: set[str],
    known_asins: set[str],
    now: datetime,
) -> dict[str, Any]:
    """Persist a B-table ad report (10 subtypes) to ad_upload_files + detail rows.

    Reuses the canonical helpers from
    ``backend/app/services/ad/upload/`` so the RPA path stays byte-identical
    with the HTTP endpoint (POST /api/v1/ad-upload/commit). The only
    differences are:
      - no FastAPI HTTPException (raises plain ValueError on bad input)
      - file moves to ``广告Processed/`` (driven by report_type)
    """
    report_type = result.report_type
    normalized_country = _normalize_country(country)
    file_size_bytes = file_path.stat().st_size

    # Compute SHA-256 of the source file once; reused for all (periodic) scopes.
    file_sha256_hash = _sha256_file(file_path)

    # Parse the source dataframe using the B-table shared helpers
    raw_df = _ad_read_dataframe(file_path)
    source_df = _ad_prepare_df(raw_df)

    # Detect single-day vs periodic (日期-column) layout
    has_period_columns = "开始日期" in source_df.columns and "结束日期" in source_df.columns
    is_periodic_row_date = (
        "日期" in source_df.columns
        and not has_period_columns
    )

    # Compute report label from the matched spec
    spec = result.spec
    report_label = spec.report_label if spec else report_type

    # Period dates from recognition result
    period_start_date: date | None = None
    period_end_date: date | None = None
    if result.detected_start_date:
        period_start_date = _parse_yyyy_mm_dd(result.detected_start_date)
    if result.detected_end_date:
        period_end_date = _parse_yyyy_mm_dd(result.detected_end_date)
    if period_start_date is None and period_end_date is None:
        # Fallback: use today (file ingestion date)
        period_start_date = period_end_date = now.date()

    saved_rows: list = []
    if is_periodic_row_date:
        # Multi-day file — split by 日期 column, one AdUploadFile per day
        import pandas as pd
        source_df = source_df.copy()
        source_df["__row_date__"] = pd.to_datetime(source_df["日期"], errors="coerce")
        normalized_range = source_df.dropna(subset=["__row_date__"]).copy()

        if normalized_range.empty:
            # Empty file (column headers only, no data rows): still persist one
            # empty-scope record so the RPA status grid shows "processed for today".
            # This matches A-table behaviour where an empty file creates a source row
            # with row_count_total=0 and writes an upload log.
            scope_date = period_end_date or period_start_date or now.date()
            file_id = _generate_file_id(file_path.name)
            row = save_ad_upload_scope(
                db,
                project=project,
                report_type=report_type,
                country=normalized_country,
                report_label=report_label,
                scope_date=scope_date,
                scope_df=source_df,
                row_count_preview=0,
                file_id=file_id,
                file_path=str(file_path),
                original_filename=file_path.name,
                recognition_status="recognized",
                matched_columns=list(result.matched_columns or []),
                warnings=list(result.warnings or []),
                recognition_payload={
                    "report_type": report_type,
                    "report_label": report_label,
                    "scope_date": scope_date.isoformat(),
                    "row_count_preview": 0,
                    "source": "autoReportUpload",
                    "note": "empty file (column headers only)",
                },
                created_by="autoReportUpload",
                file_sha256=file_sha256_hash,
            )
            saved_rows.append(row)
        else:
            normalized_range["__row_date_key__"] = normalized_range["__row_date__"].dt.strftime("%Y-%m-%d")
            for row_date_text, scope_df in normalized_range.groupby("__row_date_key__", sort=True):
                scope_date = _parse_yyyy_mm_dd(str(row_date_text))
                scope_df_clean = scope_df.drop(columns=["__row_date__", "__row_date_key__"])
                file_id = _generate_file_id(file_path.name)
                row = save_ad_upload_scope(
                    db,
                    project=project,
                    report_type=report_type,
                    country=normalized_country,
                    report_label=report_label,
                    scope_date=scope_date,
                    scope_df=scope_df_clean,
                    row_count_preview=len(scope_df_clean.index),
                    file_id=file_id,
                    file_path=str(file_path),
                    original_filename=file_path.name,
                    recognition_status="recognized",
                    matched_columns=list(result.matched_columns or []),
                    warnings=list(result.warnings or []),
                    recognition_payload={
                        "report_type": report_type,
                        "report_label": report_label,
                        "scope_date": scope_date.isoformat(),
                        "row_count_preview": len(scope_df_clean.index),
                        "source": "autoReportUpload",
                    },
                    created_by="autoReportUpload",
                    file_sha256=file_sha256_hash,
                )
                saved_rows.append(row)
    else:
        # Single-day file (typical case) — one AdUploadFile
        scope_date = period_end_date or period_start_date or now.date()
        file_id = _generate_file_id(file_path.name)
        row = save_ad_upload_scope(
            db,
            project=project,
            report_type=report_type,
            country=normalized_country,
            report_label=report_label,
            scope_date=scope_date,
            scope_df=source_df,
            row_count_preview=result.row_count_preview or len(source_df.index),
            file_id=file_id,
            file_path=str(file_path),
            original_filename=file_path.name,
            recognition_status="recognized",
            matched_columns=list(result.matched_columns or []),
            warnings=list(result.warnings or []),
            recognition_payload={
                "report_type": report_type,
                "report_label": report_label,
                "scope_date": scope_date.isoformat(),
                "row_count_preview": result.row_count_preview or len(source_df.index),
                "source": "autoReportUpload",
            },
            created_by="autoReportUpload",
            file_sha256=file_sha256_hash,
        )
        saved_rows.append(row)

    # Mark ingestion_status as 'success' so that the RPA status Priority-3
    # query (AdUploadFile.ingestion_status == 'success') can match these rows.
    # Without this, the status grid stays red because the default 'saved'
    # from save_ad_upload_scope() doesn't satisfy the query condition.
    for row in saved_rows:
        row.ingestion_status = 'success'

    # Write a single ReportUploadLog for today (upload date) so that the RPA
    # status grid shows green for the CURRENT day — not just the business dates
    # covered by AdUploadFile period ranges (Priority 3).
    # This mirrors what A-table reports do in _persist_single_source():
    # write an upload log with upload_date = now.date().
    # One log per (project, report_type, country, today) is enough; even if
    # the file spans multiple days, we only need one entry to mark today.
    # source_file_id is None because ReportUploadLog.source_file_id FK points
    # at analysis_source_files (A-table), not ad_upload_files (C-table).
    upload_date = _resolve_upload_date(now)
    last_row = saved_rows[-1]
    has_real_data = last_row.row_count_preview is not None and last_row.row_count_preview > 0
    _write_upload_log(
        db,
        project_id=int(project.id),
        report_type=report_type,
        country=normalized_country,
        upload_date=upload_date,
        has_real_data=has_real_data,
        row_count=last_row.row_count_preview or 0,
        source_file_id=None,
        original_filename=file_path.name,
    )

    db.commit()
    for saved_row in saved_rows:
        db.refresh(saved_row)

    return {
        "success": True,
        "source_id": int(saved_rows[-1].id),
        "row_count": len(saved_rows),
        "report_start_date": saved_rows[0].period_start_date.isoformat() if saved_rows else None,
        "report_end_date": saved_rows[-1].period_end_date.isoformat() if saved_rows else None,
    }


def _persist_inventory_ledger(
    *,
    db: Session,
    file_path: Path,
    project: Project,
    report_type: str,
    country: str,
) -> dict[str, Any]:
    """Persist an inventory ledger CSV via the typed ingestion service.

    与 HTTP 路径（backend/app/services/data/upload/persistence.py 的
    inventory_ledger_summary / inventory_ledger_detail 分支）完全一致：
    读取文件字节 → ``ingest_ledger_csv(expected_kind=...)`` → 写 upload log。

    ``expected_kind`` 是类型化契约：声明类型与 CSV 表头检测结果不一致 /
    格式不完整时 ``ingest_ledger_csv`` 抛 ``ValueError``，这里转为结构化失败
    结果（保留原始可操作错误信息），绝不回退到 A 表 ``_persist_single_source``
    或重新猜测目标视图。

    Outcome 额外携带 ``report_kind``（summary / detail），供 daemon 日志
    展示本次入库的是哪个视图。
    """
    from app.services.inventory.ledger import ingest_ledger_csv

    ledger_kind = LEDGER_KIND_BY_REPORT_TYPE[report_type]
    view_label = "汇总视图" if ledger_kind == "summary" else "明细视图"

    with open(file_path, "rb") as f:
        csv_content = f.read()

    try:
        row_count = ingest_ledger_csv(
            db,
            project_id=int(project.id),
            csv_content=csv_content,
            filename=file_path.name,
            loaded_by="autoReportUpload",
            expected_kind=ledger_kind,
        )
    except ValueError as exc:
        # 声明类型与表头不一致 / 格式不完整：结构化失败，错误信息面向用户可操作。
        return {
            "success": False,
            "error": str(exc),
            "report_type": report_type,
            "report_kind": ledger_kind,
        }

    # Write a single ReportUploadLog for today so the RPA status grid shows the
    # file as processed (same convention as B-table ad reports). source_file_id
    # is None — the FK points at analysis_source_files (A 表)，分类账走批次表。
    now = datetime.now()
    _write_upload_log(
        db,
        project_id=int(project.id),
        report_type=report_type,
        country=country,
        upload_date=_resolve_upload_date(now),
        has_real_data=row_count > 0,
        row_count=row_count,
        source_file_id=None,
        original_filename=file_path.name,
    )
    db.commit()

    return {
        "success": True,
        "source_id": None,
        "row_count": row_count,
        "report_kind": ledger_kind,
        "report_type": report_type,
        "report_label": view_label,
    }


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

    # Parse return rows FIRST so we know the report's actual data span.
    # BEL-127: ``period_start_date`` / ``period_end_date`` must reflect the
    # CSV's return-date range, NOT the upload date. ``return_report`` is in
    # ``PERIODIC_REPORT_TYPES`` and ``replace_current_pointer`` /
    # ``next_version`` are scoped on period — using ``upload_date`` caused
    # two uploads of non-overlapping date ranges to collide on the same
    # (project, type, country, period) slot and silently overwrite each
    # other.
    df = _recog_csv(file_path, sep="\t")
    df.columns = [str(c).strip() for c in df.columns]

    try:
        parsed_rows, raw_datetimes = _parse_return_rows(df)
    except ValueError as exc:
        # 解析失败时仍然写 upload log（没有 source_file_id），确保 RPA 状态格子显示"已处理（失败）"
        log_date = _resolve_upload_date(now)
        _write_upload_log(
            db,
            project_id=project.id,
            report_type="return_report",
            country=country,
            upload_date=log_date,
            has_real_data=False,
            row_count=0,
            source_file_id=None,
            original_filename=file_path.name,
        )
        db.commit()
        return {"success": False, "error": str(exc)}

    # Compute the period from the parsed return-date range. Empty CSV
    # (no rows) falls back to ``upload_date`` so the source_file still
    # has a valid period key — match the convention used by the other
    # PERIODIC report persistence paths (see
    # ``backend/app/services/analysis/return_analysis/persistence.py``).
    all_us_dates: list[date] = []
    for parsed in parsed_rows:
        raw_dt = parsed["return_date_raw"]
        return_date_str = _convert_to_us_date(raw_dt)
        all_us_dates.append(_parse_yyyy_mm_dd(return_date_str))

    period_start = min(all_us_dates) if all_us_dates else upload_date
    period_end = max(all_us_dates) if all_us_dates else upload_date

    # Create source file record
    file_id = _generate_file_id(file_path.name)
    extension = file_path.suffix.lower()
    project_slug = _project_slug(project.project_name)
    version = _next_version(
        db, project_id=project.id, report_type="return_report", country=country,
        period_start_date=period_start, period_end_date=period_end,
    )
    logical_filename = _build_logical_filename(
        project_slug, "return_report", period_start, period_end, now, version, extension
    )
    storage_key = _build_storage_key(
        project_slug, "return_report", period_start, period_end, version, file_id
    )

    source = AnalysisSourceFile(
        project_id=project.id,
        report_type="return_report",
        country=country,
        report_date=None,
        period_start_date=period_start,
        period_end_date=period_end,
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

    rows: list[dict] = []

    for idx, parsed in enumerate(parsed_rows):
        raw_dt = parsed["return_date_raw"]
        return_date_str = _convert_to_us_date(raw_dt)
        us_date = _parse_yyyy_mm_dd(return_date_str)

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
            # BEL-348: 冗余 project_id，供行级 upsert / 直接按行计数使用。
            item["project_id"] = project.id
            if item.get("is_counted_sales"):
                included += 1
            payloads.append(item)

        # BEL-348: 行级 upsert——同一 (project_id, amazon_order_id, sku, country)
        # 多次上报合并为一行，避免整文件版本选择丢单。
        if payloads:
            _upsert_sales_order_rows(db, payloads)

        source.row_count_total = len(payloads)
        source.row_count_included = included
        source.ingestion_status = "success"

        # BEL-348: 销售订单行已改为行级 upsert（_upsert_sales_order_rows），
        # 计数/查询直接按行过滤（counted_sales_where），不再依赖 source_file
        # 的 is_current 版本选择。因此这里不再调用 _replace_current_pointer /
        # 维护 is_current 指针——那只会留下冗余的 is_current 历史版本，且
        # 若将来任何查询误按 is_current 读销售将重现 BEL-348 丢单根因。
        # source 记录本身仍保留（作为血缘/审计 + 驱动 RPA 状态格子）。
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
        # A-table payment reports may include SKU that have been delisted but
        # still belong to the project — reload known_skus/known_asins with
        # include_inactive=True so that classify_scope marks these rows as
        # ``included_product`` instead of ``excluded_unmapped``.  Mirrors the
        # BEL-104 inventory_report fix below.
        payment_known_skus, payment_known_asins = _load_project_product_mapping(
            db, project_name, country, include_inactive=True,
        )
        rows, total, included = _parse_payment_rows(
            df, source_id, payment_known_skus, payment_known_asins,
        )
        if rows:
            db.execute(insert(AnalysisPaymentRow), rows)
        return total, included

    if report_type == "inventory_report":
        rows, total, included = _parse_inventory_rows(path, source_id)
        all_skus, all_asins = _load_project_product_mapping(
            db, project_name, country, include_inactive=True,
        )
        _validate_inventory(rows, project_name=project_name, country=country, known_skus=all_skus, known_asins=all_asins)
        if rows:
            db.execute(insert(InventorySnapshotRow), rows)
        return total, included

    # ad_*_report types are NOT handled here — they go through the B-table
    # pipeline (_persist_ad_upload_report) which delegates to
    # app.services.ad.upload.persistence.save_ad_upload_scope.
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


def _move_to_processed(file_path: Path, report_type: str | None = None) -> None:
    """Move file to its processed subfolder.

    Ad reports (any B-table ad_*_report type) go to a dedicated
    ``广告Processed/`` folder so the 10 ad subtypes stay separate from the
    general 7 report types. Other reports keep the default ``processed/`` folder.
    """
    if report_type and report_type in B_TABLE_AD_REPORT_TYPES:
        subdir = AD_PROCESSED_SUBDIR
    else:
        subdir = PROCESSED_SUBDIR
    # 文件可能位于国家子文件夹（如 <project>/美国/）——processed 归档统一
    # 放在项目根目录下，不在美国子文件夹内重新生成（BLF-646）。
    project_dir = resolve_project_dir(file_path)
    processed_dir = project_dir / subdir
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
    db: Session, project_name: str, country: str, *, include_inactive: bool = False
) -> tuple[set[str], set[str]]:
    stmt = select(ProductCost.sku, ProductCost.asin).where(
        ProductCost.project_id == Project.id,
        Project.project_name == project_name,
        ProductCost.country == country,
    )
    if not include_inactive:
        stmt = stmt.where(ProductCost.is_active.is_(True))
    rows = db.execute(stmt).all()
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

    Scans A-table (analysis_source_files), C-table (ad_upload_files) AND
    L-table (inventory_ledger_ingest_batch) for any prior ingestion of this
    exact file.  Returns list of dicts with project_id, report_type, country,
    source_id, row_count_total, and table (so callers can log which table held
    the duplicate).
    """
    duplicates: list[dict] = []

    # A-table: 业务/销售/付款/库存/退货 (5 types still active)
    a_rows = db.execute(
        select(AnalysisSourceFile).where(
            AnalysisSourceFile.file_sha256 == file_sha256
        )
    ).scalars().all()
    for row in a_rows:
        duplicates.append({
            "project_id": row.project_id,
            "report_type": row.report_type,
            "country": row.country,
            "source_id": row.id,
            "row_count_total": row.row_count_total,
            "table": "A",
        })

    # C-table: ad_*_report (10 types). Periodic files split into multiple
    # AdUploadFile rows (one per scope_date) — each is a separate match.
    c_rows = db.execute(
        select(AdUploadFile).where(
            AdUploadFile.file_sha256 == file_sha256
        )
    ).scalars().all()
    for row in c_rows:
        # C-table AdUploadFile uses period_start_date / period_end_date as
        # the canonical "row_count" signal — total_ad_rows lives on the
        # related detail row table (not all share the same column name),
        # so we report 0 here and rely on log_warnings for context.
        duplicates.append({
            "project_id": int(row.project_id),
            "report_type": row.report_type,
            "country": row.country,
            "source_id": int(row.id),
            "row_count_total": 0,
            "table": "C",
        })

    # L-table: inventory_ledger_ingest_batch（库存分类账）。仅 status=="success"
    # 的批次算重复 —— failed/pending 批次不拦截重试。file_hash 是
    # ingest_ledger_csv 对解码后内容算的 sha256，与 _sha256_file（原始字节）
    # 在无 BOM 的 UTF-8 文件上一致；带 BOM 时 miss，由批次 natural-key 幂等
    # （同 file 重传返回 0 行）兜底。
    l_rows = db.execute(
        select(InventoryLedgerIngestBatch).where(
            InventoryLedgerIngestBatch.file_hash == file_sha256,
            InventoryLedgerIngestBatch.status == "success",
        )
    ).scalars().all()
    for row in l_rows:
        duplicates.append({
            "project_id": int(row.project_id),
            "report_type": _LEDGER_REPORT_TYPE_BY_KIND.get(
                row.file_kind, "inventory_ledger_unknown"
            ),
            "country": "US",
            "source_id": int(row.id),
            "row_count_total": int(row.rows_written_summary or 0)
            + int(row.rows_written_detail or 0),
            "table": "L",
        })

    return duplicates
