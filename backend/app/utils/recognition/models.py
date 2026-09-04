"""Shared dataclass models for recognition results (no FastAPI/Pydantic deps)."""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class RecognitionResult:
    """Result of recognizing a single file.

    Shared between backend and autoReportUpload.
    """

    report_type: str
    matched_columns: list[str]
    reason: str
    date_input_mode: str
    detected_date: str | None = None
    detected_start_date: str | None = None
    detected_end_date: str | None = None
    row_count_preview: int | None = None
    warnings: list[str] = field(default_factory=list)
    country: str = "US"


# ─── DateInputMode constants ──────────────────────────────────────────────────
# single_manual  : date must be entered manually (no detection)
# single_auto    : single date auto-detected from file
# range_manual   : date range must be entered manually (no detection)
# range_auto     : date range auto-detected from file
