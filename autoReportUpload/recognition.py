"""
Report type recognition for the auto-report-upload service.

Two recognition pipelines:
  - B 表 (ad_upload_*) — 10 ad report subtypes via app.services.ad.upload.specs
  - A 表 (analysis_*) — 7 general report types via app.utils.recognition

AutoReportUpload tries B 表 first, then A 表. Ad reports always go to B 表
because A 表's analysis_ad_product_rows was dropped in alembic 152.

库存分类账（inventory_ledger_summary / inventory_ledger_detail）由 A 表共享
recognizer 输出两个独立类型（Tasks 1-2 已拆分），RPA 直接复用后端签名逻辑，
不重复实现；persistence 走 processor 的类型化 ingestion 分支。
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

# Add backend to Python path so we can import the shared recognition module
_BACKEND_PATH = Path(__file__).resolve().parent.parent / "backend"
if str(_BACKEND_PATH) not in sys.path:
    sys.path.insert(0, str(_BACKEND_PATH))

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.utils.payment_locale import read_payment_report_dataframe
from app.utils.recognition import (
    recognize_file as _shared_recognize_file,
    RecognitionResult as SharedRecognitionResult,
    _normalize_columns,
    _read_csv_with_encoding_fallback,
)

# B 表 ad report recognition — independent from A 表 per architecture note in specs.py
from app.services.ad.upload.specs import REPORT_SPECS, ReportSpec
from app.services.ad.upload.recognition import _detect_report_spec
from app.services.ad.upload.utils import _find_column_ci, _read_dataframe, _date_to_string
from app.services.ad.upload.project_match import _build_project_match

from config import resolve_project_dir
from models import ProductCost

# ─── Set of B-table ad report types (for routing in processor.py) ─────────────
# Sourced from REPORT_SPECS so the source of truth stays in one place.
B_TABLE_AD_REPORT_TYPES: frozenset[str] = frozenset(
    spec.report_type for spec in REPORT_SPECS
)


# ─── Custom result with project_match (RPA-specific) ───────────────────────────


class RecognitionResult:
    """Extended recognition result with project matching (RPA-specific)."""

    def __init__(
        self,
        report_type: str,
        matched_columns: list[str],
        reason: str,
        date_input_mode: str,
        detected_date: str | None = None,
        detected_start_date: str | None = None,
        detected_end_date: str | None = None,
        row_count_preview: int | None = None,
        warnings: list[str] | None = None,
        country: str = "US",
        project_match: dict | None = None,
        spec: ReportSpec | None = None,
    ):
        self.report_type = report_type
        self.matched_columns = matched_columns
        self.reason = reason
        self.date_input_mode = date_input_mode
        self.detected_date = detected_date
        self.detected_start_date = detected_start_date
        self.detected_end_date = detected_end_date
        self.row_count_preview = row_count_preview
        self.warnings = warnings or []
        self.country = country
        self.project_match = project_match
        # Non-None when this result was produced by the B-table ad specs pipeline.
        # processor.py uses this flag to dispatch to the C-table persister.
        self.spec = spec

    @classmethod
    def from_shared_result(cls, result: SharedRecognitionResult) -> "RecognitionResult":
        """Create from shared RecognitionResult (without project_match, A-table path)."""
        return cls(
            report_type=result.report_type,
            matched_columns=result.matched_columns,
            reason=result.reason,
            date_input_mode=result.date_input_mode,
            detected_date=result.detected_date,
            detected_start_date=result.detected_start_date,
            detected_end_date=result.detected_end_date,
            row_count_preview=result.row_count_preview,
            warnings=result.warnings,
            country=result.country,
            project_match=None,
            spec=None,
        )


# ─── B-table ad report recognition ─────────────────────────────────────────────


def _try_recognize_b_table_ad(path: Path, country: str) -> tuple[ReportSpec, Any] | None:
    """Try to match the file against the 10 B-table ad report specs.

    Returns (spec, dataframe) on success; None on miss. Raises on read errors
    (caller catches and falls through to A-table recognition).
    """
    df = _read_dataframe(path)
    spec = _detect_report_spec(df, path.suffix.lower())
    if spec is None:
        return None
    return spec, df


def _build_b_table_result(
    db: Session,
    path: Path,
    spec: ReportSpec,
    df: Any,
    country: str,
    original_filename: str,
) -> RecognitionResult:
    """Build a RecognitionResult for a B-table ad report match."""
    detected_country = country
    country_col = _find_column_ci(df.columns, "国家/地区")
    if country_col and not df[country_col].dropna().empty:
        from app.utils.country import normalize_country as _norm_country
        try:
            detected_country = _norm_country(str(df[country_col].dropna().iloc[0]).strip())
        except Exception:
            detected_country = country

    detected_start_date: str | None = None
    detected_end_date: str | None = None
    start_col = _find_column_ci(df.columns, "开始日期")
    end_col = _find_column_ci(df.columns, "结束日期")
    date_col = _find_column_ci(df.columns, "日期")
    if start_col and end_col:
        if not df[start_col].dropna().empty:
            detected_start_date = _date_to_string(df[start_col].dropna().iloc[0])
        if not df[end_col].dropna().empty:
            detected_end_date = _date_to_string(df[end_col].dropna().iloc[0])
    elif date_col and not df[date_col].dropna().empty:
        import pandas as pd
        parsed = pd.to_datetime(df[date_col], errors="coerce").dropna()
        if not parsed.empty:
            detected_start_date = parsed.min().strftime("%Y-%m-%d")
            detected_end_date = parsed.max().strftime("%Y-%m-%d")

    warnings_list: list[str] = []
    if len(df.index) == 0:
        warnings_list.append("报表已识别，但当前文件没有业务明细行")

    # B-table project matching via the canonical helper (no operator → no allow-list filter)
    try:
        project_summary = _build_project_match(
            db,
            df=df,
            spec=spec,
            country=detected_country,
            allowed_projects=None,
        )
        project_match = {
            "status": project_summary.status,
            "project_name": project_summary.project_name,
            "candidate_projects": list(project_summary.candidate_projects),
            "matched_by": project_summary.matched_by,
            "matched_values": list(project_summary.matched_values),
            "message": project_summary.message,
        }
    except Exception as exc:  # noqa: BLE001
        project_match = {
            "status": "manual",
            "message": f"项目匹配失败: {exc}",
        }

    # RPA fallback: when spec has no project_match_fields (most ad subtypes
    # like ad_placement / ad_campaign don't carry SKU/ASIN), the canonical
    # helper returns status='manual'. In the RPA path the file lives inside
    # a project folder, so fall back to folder-name matching — same policy
    # A-table reports already use.
    if project_match["status"] in {"unmatched", "manual"}:
        from models import Project
        from sqlalchemy import select
        folder_name = resolve_project_dir(path).name
        project = db.execute(
            select(Project).where(Project.project_name == folder_name)
        ).scalars().first()
        if project:
            project_match = {
                "status": "matched",
                "project_name": project.project_name,
                "candidate_projects": [project.project_name],
                "matched_by": "folder_name",
                "matched_values": [],
                "message": f"根据目录名 [{folder_name}] 匹配项目（spec 无 project_match_fields 走 fallback）",
            }

    return RecognitionResult(
        report_type=spec.report_type,
        matched_columns=list(spec.required_columns),
        reason=f"命中 B 表 ad 报表规则：{spec.report_label}",
        date_input_mode="single_detected" if detected_start_date == detected_end_date else "range_detected",
        detected_date=detected_end_date or detected_start_date,
        detected_start_date=detected_start_date,
        detected_end_date=detected_end_date,
        row_count_preview=len(df.index),
        warnings=warnings_list,
        country=detected_country,
        project_match=project_match,
        spec=spec,
    )


# ─── A-table project matching (legacy, only for non-ad reports) ───────────────


def _add_project_match(result: RecognitionResult, db: Session, path: Path, country: str) -> RecognitionResult:
    """Add project matching to a recognition result (A-table reports only)."""
    try:
        import pandas as pd

        if result.report_type in {"inventory_report", "sales_report", "return_report"}:
            df = _normalize_columns(_read_csv_with_encoding_fallback(path))
            match_by = "sku"
            values = df[match_by].dropna().astype(str).tolist()
        elif result.report_type == "business_report":
            df = _normalize_columns(_read_csv_with_encoding_fallback(path, sep=","))
            match_by = "asin"
            asin_col = next(
                (c for c in ["（子）asin", "(子)asin", "子asin", "asin"] if c in df.columns),
                None,
            )
            if asin_col:
                values = df[asin_col].dropna().astype(str).tolist()
            else:
                values = []
        elif result.report_type == "payment_report":
            df = read_payment_report_dataframe(path, country=country)
            df = _normalize_columns(df)
            match_by = "sku"
            values = df["sku"].dropna().astype(str).tolist()
        elif result.report_type in {"inventory_ledger_summary", "inventory_ledger_detail"}:
            # 库存分类账两种视图都含 MSKU 列 —— 按 MSKU（即 ProductCost.sku）
            # 匹配项目；匹配不到再走目录名 fallback（与其它 A 表报表一致）。
            # 修复：旧代码此处落入 else → values=[] 后引用未绑定的 match_by，
            # UnboundLocalError 被吞成 project_match="manual"，process_file
            # 会以「项目匹配状态为 manual」跳过所有库存分类账文件。
            df = _normalize_columns(_read_csv_with_encoding_fallback(path, sep=","))
            msku_col = next((c for c in ["msku", "sku"] if c in df.columns), None)
            match_by = "sku"
            values = df[msku_col].dropna().astype(str).tolist() if msku_col else []
        else:
            values = []

        if values:
            result.project_match = _build_project_match_legacy(
                db,
                values=values,
                match_by=match_by,
                country=country,
            )
        else:
            result.project_match = {
                "status": "unmatched",
                "matched_by": match_by,
                "message": "文件中未找到可用于匹配项目的标识",
            }

        # 如果无法通过 SKU/ASIN 匹配（例如文件内容为空），回退到目录名匹配
        if result.project_match["status"] == "unmatched":
            from models import Project
            from sqlalchemy import select
            folder_name = resolve_project_dir(path).name
            project = db.execute(
                select(Project).where(Project.project_name == folder_name)
            ).scalars().first()
            if project:
                result.project_match = {
                    "status": "matched",
                    "project_name": project.project_name,
                    "matched_by": "folder_name",
                    "message": f"根据目录名 [{folder_name}] 匹配项目（内容匹配失败）",
                }
            else:
                result.project_match["message"] = (
                    f"{result.project_match['message']}；目录名 [{folder_name}] 未在数据库中找到对应项目"
                )

    except Exception as exc:
        result.project_match = {"status": "manual", "message": f"项目匹配失败: {exc}"}

    return result


def _build_project_match_legacy(
    db: Session,
    *,
    values: list[str],
    match_by: str,
    country: str = "US",
) -> dict[str, Any]:
    """Match files to projects by SKU or ASIN (A-table RPA-specific implementation)."""
    from sqlalchemy import func, select

    def _normalize_identifier(value: object) -> str:
        if value is None:
            return ""
        text = str(value).strip()
        if not text or text.lower() == "nan":
            return ""
        return text.upper()

    normalized_values = sorted(
        {_normalize_identifier(v) for v in values if _normalize_identifier(v)}
    )
    if not normalized_values:
        return {
            "status": "unmatched",
            "matched_by": match_by,
            "message": "文件中未找到可用于匹配项目的标识",
        }

    col = ProductCost.sku if match_by == "sku" else ProductCost.asin
    normalized_lower = [v.lower() for v in normalized_values]
    # A-table reports (business/payment/sales/inventory/return) may include
    # SKU/ASIN that have been delisted but still belong to a project — match
    # against both active and inactive records.  This mirrors the HTTP entry's
    # behavior in backend/app/services/data/upload/project_match.py after the
    # BEL-104 fix.
    rows = (
        db.execute(
            select(ProductCost.project_name)
            .where(func.lower(col).in_(normalized_lower))
            .where(ProductCost.country == country)
            .distinct()
        )
        .scalars()
        .all()
    )
    all_projects = sorted(set(rows))

    if len(all_projects) == 1:
        return {
            "status": "matched",
            "project_name": all_projects[0],
            "matched_by": match_by,
            "message": f"已根据{match_by.upper()}自动匹配项目",
        }
    if len(all_projects) > 1:
        return {
            "status": "conflict",
            "candidate_projects": all_projects,
            "matched_by": match_by,
            "message": f"检测到多个项目，请手动确认（{len(all_projects)} 个候选项目）",
        }
    return {
        "status": "unmatched",
        "matched_by": match_by,
        "message": "未匹配到项目",
    }


# ─── Main entry point ─────────────────────────────────────────────────────────


def recognize_file(
    db: Session,
    path: Path,
    country: str = "US",
    original_filename: str = "",
) -> RecognitionResult | None:
    """
    Recognize a file's report type. Returns None if no known report type matches.

    Order:
      1. B-table ad specs (10 ad subtypes) — writes to ad_upload_*
      2. A-table general recognition (sales / business / payment / inventory /
         return / ad_search_term) — writes to analysis_*
    """
    # 1) B-table ad pipeline (10 subtypes)
    try:
        b_match = _try_recognize_b_table_ad(path, country)
        if b_match is not None:
            spec, df = b_match
            return _build_b_table_result(db, path, spec, df, country, original_filename)
    except HTTPException:
        # _detect_report_spec raises HTTPException(400) when nothing matches
        pass
    except Exception:
        # Read errors → fall through to A-table in case the file is a different type
        pass

    # 2) A-table general recognition
    shared_result = _shared_recognize_file(path, country=country, original_filename=original_filename)
    if shared_result is None:
        return None

    result = RecognitionResult.from_shared_result(shared_result)
    result = _add_project_match(result, db, path, country)
    return result
