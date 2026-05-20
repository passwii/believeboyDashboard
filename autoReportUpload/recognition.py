"""
Report type recognition for the auto-report-upload service.

Uses recognition module from backend/app/utils/recognition/
for non-payment report types. Payment reports use backend/app/services/payment/locale/.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

# Load backend .env first (validates DATABASE_URL / API_KEY),
# then autoReportUpload .env second (adds AUTO_REPORT_ENV / DIGITAL_EMPLOYEE_*).
# Neither call overrides already-set values, so the backend's DATABASE_URL
# and API_KEY are never clobbered by the service's own .env file.
_backend_env = Path(__file__).resolve().parent.parent / "backend" / ".env"
load_dotenv(_backend_env)
_env_path = Path(__file__).parent / ".env"
load_dotenv(_env_path)

# Add backend to Python path so we can import the shared recognition module
_BACKEND_PATH = Path(__file__).resolve().parent.parent / "backend"
if str(_BACKEND_PATH) not in sys.path:
    sys.path.insert(0, str(_BACKEND_PATH))

from sqlalchemy.orm import Session

from app.utils.payment_locale import read_payment_report_dataframe
from app.utils.recognition import (
    recognize_file as _shared_recognize_file,
    RecognitionResult as SharedRecognitionResult,
    _normalize_columns,
    _read_csv_with_encoding_fallback,
    _read_excel,
)
from models import ProductCost

# Re-export AD_PRODUCT_REPORT for compatibility
AD_PRODUCT_REPORT = "ad_product_report"


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

    @classmethod
    def from_shared_result(cls, result: SharedRecognitionResult) -> "RecognitionResult":
        """Create from shared RecognitionResult (without project_match)."""
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
        )


# ─── Project matching (RPA-specific, different from backend) ──────────────────


def _build_project_match(
    db: Session,
    *,
    values: list[str],
    match_by: str,
    country: str = "US",
) -> dict[str, Any]:
    """Match files to projects by SKU or ASIN (RPA-specific implementation)."""
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
    rows = (
        db.execute(
            select(ProductCost.project_name)
            .where(func.lower(col).in_(normalized_lower))
            .where(ProductCost.is_active.is_(True))
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


def _add_project_match(result: RecognitionResult, db: Session, path: Path, country: str) -> RecognitionResult:
    """Add project matching to a recognition result."""
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
                (c for c in ["（子）ASIN", "(子)ASIN", "子ASIN", "ASIN"] if c in df.columns),
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
        elif result.report_type == AD_PRODUCT_REPORT:
            df = _normalize_columns(_read_excel(path))
            match_by = "sku"
            values = df["广告SKU"].dropna().astype(str).tolist()
        elif result.report_type == "ad_search_term_report":
            result.project_match = {"status": "manual", "message": "该报表项目需手动选择"}
            return result
        else:
            values = []

        if values:
            result.project_match = _build_project_match(
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

        # 如果 payment_report 无法通过 SKU/ASIN 匹配，回退到目录名匹配
        if result.project_match["status"] == "unmatched" and result.report_type == "payment_report":
            from models import Project
            from sqlalchemy import select
            folder_name = path.parent.name
            project = db.execute(
                select(Project).where(Project.project_name == folder_name)
            ).scalars().first()
            if project:
                result.project_match = {
                    "status": "matched",
                    "project_name": project.project_name,
                    "matched_by": "folder_name",
                    "message": f"根据目录名 [{folder_name}] 匹配项目（SKU 匹配失败）",
                }
            else:
                result.project_match["message"] = (
                    f"{result.project_match['message']}；目录名 [{folder_name}] 未在数据库中找到对应项目"
                )

    except Exception as exc:
        result.project_match = {"status": "manual", "message": f"项目匹配失败: {exc}"}

    return result


# ─── Main entry point ─────────────────────────────────────────────────────────


def recognize_file(
    db: Session,
    path: Path,
    country: str = "US",
    original_filename: str = "",
) -> RecognitionResult | None:
    """
    Recognize a file's report type using the shared recognition module.

    Returns None if the file doesn't match any known report type (skip the file).
    """
    # Use shared recognition module
    shared_result = _shared_recognize_file(path, country=country, original_filename=original_filename)

    if shared_result is None:
        return None

    # Convert to RPA-specific result
    result = RecognitionResult.from_shared_result(shared_result)

    # Add project matching (RPA-specific)
    result = _add_project_match(result, db, path, country)

    return result
