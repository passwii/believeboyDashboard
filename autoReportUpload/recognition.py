"""
Report type recognition for the autoReportUpload service.

Pure functions only — no DB session, no I/O beyond reading the file.
Project matching is done via the backend ``/recognize`` endpoint.

Two pipelines:
  - B-table ad_*_report — 10 ad subtypes
  - A-table — 5 general report types (sales / business / payment /
              inventory / return)

AutoReportUpload tries B-table first, then A-table. The order matches
``autoReportUpload/recognition.py`` from before the C-route refactor.
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

_BACKEND_PATH = Path(__file__).resolve().parent.parent / "backend"
if str(_BACKEND_PATH) not in sys.path:
    sys.path.insert(0, str(_BACKEND_PATH))

import pandas as pd

from app.services.ad.upload.specs import REPORT_SPECS, ReportSpec
from app.services.ad.upload.utils import _find_column_ci, _read_dataframe


B_TABLE_AD_REPORT_TYPES: frozenset[str] = frozenset(
    spec.report_type for spec in REPORT_SPECS
)


# ─── Result dataclass ─────────────────────────────────────────────────────────


class RecognitionResult:
    """Pure data: what we learned from the file, no DB I/O."""

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
        self.spec = spec


# ─── B-table ad spec detection (no project match here) ────────────────────────


def _detect_b_table_spec(path: Path) -> tuple[ReportSpec, pd.DataFrame] | None:
    """Return (spec, df) if the file matches one of the 10 B-table ad specs.

    Re-raises spec detection errors so the caller can fall through to A-table.
    """
    df = _read_dataframe(path)
    extension = path.suffix.lower()

    columns_lower = {str(c).strip().lower() for c in df.columns}
    from app.services.ad.upload.specs import _periodic_required_columns
    for spec in REPORT_SPECS:
        if extension not in spec.extensions:
            continue
        required_lower = tuple(str(c).lower() for c in spec.required_columns)
        if all(c in columns_lower for c in required_lower):
            return spec, df
        periodic = _periodic_required_columns(spec)
        periodic_lower = tuple(str(c).lower() for c in periodic)
        if all(c in columns_lower for c in periodic_lower):
            return (
                ReportSpec(
                    report_type=spec.report_type,
                    report_label=spec.report_label,
                    extensions=spec.extensions,
                    required_columns=periodic,
                    project_match_fields=spec.project_match_fields,
                ),
                df,
            )
    return None


def _build_b_table_result(
    path: Path, spec: ReportSpec, df: pd.DataFrame, country: str
) -> RecognitionResult:
    """Build a RecognitionResult for a B-table ad report match. No DB access."""

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
            detected_start_date = pd.to_datetime(df[start_col].dropna().iloc[0], errors="coerce")
            detected_start_date = detected_start_date.strftime("%Y-%m-%d") if detected_start_date is not None else None
        if not df[end_col].dropna().empty:
            detected_end_date = pd.to_datetime(df[end_col].dropna().iloc[0], errors="coerce")
            detected_end_date = detected_end_date.strftime("%Y-%m-%d") if detected_end_date is not None else None
    elif date_col and not df[date_col].dropna().empty:
        parsed = pd.to_datetime(df[date_col], errors="coerce").dropna()
        if not parsed.empty:
            detected_start_date = parsed.min().strftime("%Y-%m-%d")
            detected_end_date = parsed.max().strftime("%Y-%m-%d")

    warnings_list: list[str] = []
    if len(df.index) == 0:
        warnings_list.append("报表已识别，但当前文件没有业务明细行")

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
        spec=spec,
    )


# ─── A-table spec detection (re-uses the shared helper) ──────────────────────


def _detect_a_table_spec(
    path: Path, country: str
) -> RecognitionResult | None:
    """Reuse the public shared recognition helper but skip its project match."""

    from app.utils.recognition import recognize_file as _shared
    shared_result = _shared(
        path, country=country, original_filename=path.name
    )
    if shared_result is None:
        return None
    return RecognitionResult(
        report_type=shared_result.report_type,
        matched_columns=shared_result.matched_columns,
        reason=shared_result.reason,
        date_input_mode=shared_result.date_input_mode,
        detected_date=shared_result.detected_date,
        detected_start_date=shared_result.detected_start_date,
        detected_end_date=shared_result.detected_end_date,
        row_count_preview=shared_result.row_count_preview,
        warnings=shared_result.warnings,
        country=shared_result.country,
    )


# ─── Main entry point ─────────────────────────────────────────────────────────


def detect_report_type(path: Path, country: str = "US") -> RecognitionResult | None:
    """Detect a report's type, period dates, and row count.

    Pure function. No DB session, no I/O beyond reading the file.
    Returns None if no known spec matches.
    """
    try:
        b_match = _detect_b_table_spec(path)
        if b_match is not None:
            spec, df = b_match
            return _build_b_table_result(path, spec, df, country)
    except Exception:
        pass

    try:
        return _detect_a_table_spec(path, country)
    except Exception:
        return None
