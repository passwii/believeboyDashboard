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
