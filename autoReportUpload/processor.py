"""
File processor: recognize → call backend /ingest → move file.
Pure orchestration — no direct DB access. All persistence happens
inside the FastAPI service via /api/v1/internal/auto-report/ingest.
"""
from __future__ import annotations

import logging
import shutil
import time
from datetime import datetime
from pathlib import Path
from typing import Any

import pandas as pd

from api_client import APIClient, IngestError
from config import AD_PROCESSED_SUBDIR, PROCESSED_SUBDIR
from recognition import B_TABLE_AD_REPORT_TYPES, RecognitionResult, detect_report_type

logger = logging.getLogger(__name__)


def _is_ad_report(result: RecognitionResult) -> bool:
    """True when the report_type is one of the 10 B-table ad subtypes.

    Applies to both single-day (start==end) and multi-day (start<end) ad
    files — the canonical backend helper ``save_ad_upload_scope`` supports
    both, and we want scope_rows to be populated either way so detail rows
    actually land in the C-table.
    """
    return result.report_type in B_TABLE_AD_REPORT_TYPES


def _is_periodic_ad_report(result: RecognitionResult) -> bool:
    """True when the ad report covers multiple distinct days (has a "日期" column)."""
    if result.report_type not in B_TABLE_AD_REPORT_TYPES:
        return False
    if result.detected_start_date and result.detected_end_date:
        return result.detected_start_date != result.detected_end_date
    return False


def _build_a_table_scope_rows(
    file_path: Path, report_type: str, project_id: int, country: str,
) -> list[dict[str, Any]]:
    """Read the file, run the canonical parser, and return the schema-shaped
    row dicts ready to be sent as ``scope_rows`` to the backend ingest API.

    Uses the same parsers the web upload pipeline uses
    (``app.utils.parsers.parse_*_rows``) so the daemon path never drifts
    from the frontend path. Each row dict carries a synthetic
    ``source_file_id`` placeholder (0) that the backend overwrites with
    the real source id after it creates the AnalysisSourceFile.
    """
    import sys
    sys.path.insert(0, str(file_path.parent.parent / "backend"))
    from app.utils.payment_locale import read_payment_report_dataframe
    from app.utils.parsers import (
        parse_business_rows,
        parse_inventory_rows,
        parse_payment_rows,
        parse_return_rows,
        parse_sales_rows,
    )

    if report_type == "sales_report":
        payloads, _, _ = parse_sales_rows(file_path, source_file_id=0, country=country)
        return payloads
    if report_type == "business_report":
        payloads, _, _ = parse_business_rows(file_path, source_file_id=0)
        return payloads
    if report_type == "payment_report":
        df = read_payment_report_dataframe(file_path, country=country)
        # payment needs known SKU/ASIN sets to classify scope; without DB
        # access from the daemon we punt to "excluded_unmapped" — the web
        # upload path also reclassifies via its own ProductCost lookup.
        payloads, _, _ = parse_payment_rows(
            df, source_file_id=0, known_skus=set(), known_asins=set(),
        )
        return payloads
    if report_type == "return_report":
        import pandas as pd
        df = pd.read_csv(file_path, sep="\t", encoding="utf-8-sig")
        payloads, _ = parse_return_rows(df)
        for index, payload in enumerate(payloads, start=1):
            payload["source_file_id"] = 0
            payload["source_row_no"] = index
            if "return_date_raw" in payload and hasattr(payload["return_date_raw"], "date"):
                payload["return_date"] = payload["return_date_raw"].date()
                payload.pop("return_date_raw", None)
        return payloads
    if report_type == "inventory_report":
        payloads, _, _ = parse_inventory_rows(file_path, source_file_id=0)
        return payloads
    if report_type == "ad_product_report":
        # ad_product stays in A-table per BEL-54; mirror the payment
        # behavior — no SKU/ASIN set means everything is "excluded_unmapped"
        # and the row is recorded in raw_row for downstream analysis.
        from app.utils.parsers import parse_ad_rows
        payloads, _, _ = parse_ad_rows(
            file_path, source_file_id=0, known_skus=set(), known_asins=set(),
        )
        return payloads
    return []


def _sha256_file(path: Path) -> str:
    import hashlib
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _move_to_processed(file_path: Path, report_type: str | None = None) -> None:
    if report_type and report_type in B_TABLE_AD_REPORT_TYPES:
        subdir = AD_PROCESSED_SUBDIR
    else:
        subdir = PROCESSED_SUBDIR
    processed_dir = file_path.parent / subdir
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


# ─── Result dataclass (unchanged) ─────────────────────────────────────────────


class ProcessResult:
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


# ─── Entry point ──────────────────────────────────────────────────────────────


def process_file(
    file_path: Path,
    project_name: str,
    api_client: APIClient,
    dry_run: bool = False,
) -> ProcessResult:
    """Recognize a file, ask the backend to ingest it, then move to processed/.

    No DB session is taken — the APIClient handles all persistence via
    /recognize and /ingest.

    NOTE: A-table 5 个 report_type (sales/business/payment/inventory/return) send
    `scope_rows=[]` because backend _ingest_a_table is intentionally
    detail-row-only-on-source (MVP). Backend writes source row + upload log;
    A-table detail-row migration is a follow-up.
    """
    t0 = time.time()

    result = detect_report_type(file_path, country="US")
    if result is None:
        return ProcessResult(skipped=True, reason="未匹配任何报表类型")

    rec = api_client.recognize(
        folder_name=project_name,
        original_filename=file_path.name,
        country=result.country or "US",
        report_type=result.report_type,
        matched_columns=result.matched_columns,
        row_count_preview=result.row_count_preview or 0,
        detected_date=result.detected_date,
        detected_start_date=result.detected_start_date,
        detected_end_date=result.detected_end_date,
        warnings=result.warnings,
    )
    if not rec.get("can_ingest"):
        return ProcessResult(
            skipped=True,
            report_type=result.report_type,
            report_label=result.report_label,
            reason=rec.get("match_message") or "项目未匹配",
        )
    project_id = int(rec["project_id"])
    report_label = rec.get("report_label") or result.report_label

    if dry_run:
        return ProcessResult(
            success=True,
            report_type=result.report_type,
            report_label=report_label,
            reason=f"[dry-run] 会入库 {result.report_type},行数预估 {result.row_count_preview}",
        )

    file_sha256 = _sha256_file(file_path)
    file_size_bytes = file_path.stat().st_size

    scopes: list[dict[str, Any]] = []
    if _is_ad_report(result):
        from app.services.ad.upload.utils import _read_dataframe, _prepare_ingest_dataframe
        raw_df = _read_dataframe(file_path)
        source_df = _prepare_ingest_dataframe(raw_df)
        if "日期" in source_df.columns:
            with_dates = source_df.copy()
            with_dates["__row_date__"] = pd.to_datetime(with_dates["日期"], errors="coerce")
            normalized = with_dates.dropna(subset=["__row_date__"]).copy()
            if normalized.empty:
                scope_date = result.detected_end_date or result.detected_start_date or datetime.now().strftime("%Y-%m-%d")
                scopes.append(
                    {
                        "scope_date": scope_date,
                        "row_count_preview": 0,
                        "scope_rows": [],
                    }
                )
            else:
                normalized["__row_date_key__"] = normalized["__row_date__"].dt.strftime("%Y-%m-%d")
                for row_date_text, scope_df in normalized.groupby("__row_date_key__", sort=True):
                    scope_df_clean = scope_df.drop(columns=["__row_date__", "__row_date_key__"])
                    scopes.append(
                        {
                            "scope_date": str(row_date_text),
                            "row_count_preview": int(len(scope_df_clean.index)),
                            "scope_rows": scope_df_clean.to_dict(orient="records"),
                        }
                    )
        else:
            scope_date = result.detected_start_date or result.detected_end_date or datetime.now().strftime("%Y-%m-%d")
            rows = source_df.to_dict(orient="records")
            scopes.append(
                {
                    "scope_date": scope_date,
                    "row_count_preview": int(len(rows)),
                    "scope_rows": rows,
                }
            )
    else:
        scope_date = (
            result.detected_start_date
            or result.detected_end_date
            or result.detected_date
            or datetime.now().strftime("%Y-%m-%d")
        )
        try:
            rows = _build_a_table_scope_rows(
                file_path,
                result.report_type,
                project_id,
                result.country or "US",
            )
            if not rows:
                # Parser couldn't extract anything — fall back to whatever
                # was in the file (still better than 0 detail rows).
                from app.services.ad.upload.utils import (
                    _read_dataframe, _prepare_ingest_dataframe,
                )
                try:
                    raw_df = _read_dataframe(file_path)
                    source_df = _prepare_ingest_dataframe(raw_df)
                    rows = source_df.to_dict(orient="records")
                    for index, row in enumerate(rows, start=1):
                        row.setdefault("source_row_no", index)
                except Exception:
                    rows = []
            scopes.append(
                {
                    "scope_date": scope_date,
                    "row_count_preview": int(len(rows)) if rows else int(result.row_count_preview or 0),
                    "scope_rows": rows or [],
                }
            )
        except Exception as exc:
            logger.warning("A-table row builder failed for %s: %s", file_path.name, exc)
            scopes.append(
                {
                    "scope_date": scope_date,
                    "row_count_preview": int(result.row_count_preview or 0),
                    "scope_rows": [],
                }
            )

    try:
        ingest_resp = api_client.ingest(
            report_type=result.report_type,
            project_id=project_id,
            country=result.country or "US",
            original_filename=file_path.name,
            file_sha256=file_sha256,
            file_size_bytes=file_size_bytes,
            local_file_path=str(file_path.resolve()),
            matched_columns=result.matched_columns,
            warnings=result.warnings,
            report_label=report_label,
            report_date=result.detected_date,
            scopes=scopes,
        )
    except IngestError as exc:
        return ProcessResult(
            skipped=False,
            success=False,
            report_type=result.report_type,
            report_label=report_label,
            reason="后端 ingest 失败",
            error=str(exc),
        )

    status = ingest_resp.get("status")
    source_id = ingest_resp.get("source_id")
    version = ingest_resp.get("version", 0)

    try:
        _move_to_processed(file_path, result.report_type)
    except Exception as exc:
        logger.warning(f"文件移动失败(已入库): {file_path.name} — {exc}")

    total_time = time.time() - t0

    if status == "duplicate":
        return ProcessResult(
            skipped=True,
            report_type=result.report_type,
            report_label=report_label,
            reason=ingest_resp.get("message") or "SHA-256 重复",
            source_id=ingest_resp.get("duplicate_source_id"),
            row_count=0,
        )

    return ProcessResult(
        success=True,
        report_type=result.report_type,
        report_label=report_label,
        source_id=source_id,
        row_count=scopes[0]["row_count_preview"] if scopes else 0,
        country=result.country,
        detected_start_date=result.detected_start_date,
        detected_end_date=result.detected_end_date,
        reason=f"source_id={source_id} version={version} total={total_time:.1f}s",
    )