"""Shared utility functions used by both backend services and autoReportUpload.

All functions here are pure helpers with no FastAPI, SQLAlchemy model, or
framework-specific dependencies.  pandas is the only third-party import
(required by both sides anyway).

.. deprecated::
    The text normalization functions in this module (``normalize_text``,
    ``normalize_identity``) are deprecated.  Use the equivalents in
    ``app.shared.text_utils`` instead, which have consistent semantics
    (lowercase identity, more robust blank-value handling).
"""
from __future__ import annotations

import hashlib
import re
import warnings
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

import pandas as pd
from slugify import slugify

# ─── Type conversion ─────────────────────────────────────────────────────────


def to_int(value: Any) -> int:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return 0
    try:
        return int(float(str(value).strip() or "0"))
    except (TypeError, ValueError):
        return 0


def to_decimal(value: Any) -> Decimal:
    if value is None:
        return Decimal("0")
    if isinstance(value, float) and pd.isna(value):
        return Decimal("0")
    try:
        text = str(value).strip().replace(",", "")
        if not text:
            return Decimal("0")
        return Decimal(text)
    except (InvalidOperation, ValueError):
        return Decimal("0")


def to_decimal_with_currency(value: Any) -> Decimal:
    if value is None:
        return Decimal("0")
    if isinstance(value, float) and pd.isna(value):
        return Decimal("0")
    text = re.sub(r"[^0-9.\-]", "", str(value))
    if not text:
        return Decimal("0")
    try:
        return Decimal(text)
    except InvalidOperation:
        return Decimal("0")


def sum_decimals(*values: Any) -> Decimal:
    total = Decimal("0")
    for value in values:
        total += to_decimal(value)
    return total


# ─── Text normalization ─────────────────────────────────────────────────────


def normalize_text(value: Any) -> str | None:
    warnings.warn(
        "app.shared.utils.normalize_text is deprecated, use app.shared.text_utils.normalize_text instead",
        DeprecationWarning,
        stacklevel=2,
    )
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    if text.lower() == "nan":
        return None
    return text


def normalize_identity(value: Any) -> str:
    warnings.warn(
        "app.shared.utils.normalize_identity is deprecated, use app.shared.text_utils.normalize_identity instead",
        DeprecationWarning,
        stacklevel=2,
    )
    text = normalize_text(value)
    if text is None:
        return ""
    return text.lower()


# ─── File / path helpers ────────────────────────────────────────────────────


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def project_slug(project_name: str) -> str:
    cleaned = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "-", (project_name or "").strip())
    slug = slugify(cleaned)
    if not slug:
        slug = re.sub(r"\s+", "-", cleaned).strip(" .-").lower()
    return slug[:80] or "project"


def build_logical_filename(
    *,
    project_slug: str,
    report_type: str,
    period_start_date: date | None,
    period_end_date: date | None,
    snapshot_at: datetime,
    version: int,
    extension: str,
) -> str:
    safe_ext = extension if extension.startswith(".") else f".{extension}" if extension else ""
    timestamp = snapshot_at.strftime("%Y%m%dT%H%M%SZ")
    if report_type == "inventory_report":
        return f"{project_slug}__inventory_report__snapshot-{timestamp}__v{version}{safe_ext}"
    if period_start_date is None or period_end_date is None:
        raise ValueError(f"Missing period for {report_type}")
    return (
        f"{project_slug}__{report_type}__"
        f"{period_start_date.strftime('%Y%m%d')}_{period_end_date.strftime('%Y%m%d')}__"
        f"v{version}__{timestamp}{safe_ext}"
    )


def build_storage_key(
    *,
    project_slug: str,
    report_type: str,
    period_start_date: date | None,
    period_end_date: date | None,
    snapshot_at: datetime,
    version: int,
    upload_file_id: str,
) -> str:
    if report_type == "inventory_report":
        period_or_snapshot = f"snapshot-{snapshot_at.strftime('%Y%m%dT%H%M%SZ')}"
    else:
        if period_start_date is None or period_end_date is None:
            raise ValueError(f"Missing period for {report_type}")
        period_or_snapshot = f"{period_start_date.strftime('%Y%m%d')}_{period_end_date.strftime('%Y%m%d')}"
    return f"analysis/{project_slug}/{report_type}/{period_or_snapshot}/v{version}/{upload_file_id}"


# ─── Row serialization ──────────────────────────────────────────────────────


def to_raw_row(row: dict[str, Any]) -> dict[str, Any]:
    payload: dict[str, Any] = {}
    for key, value in row.items():
        text_key = str(key)
        if value is None:
            payload[text_key] = None
            continue
        if isinstance(value, float) and pd.isna(value):
            payload[text_key] = None
            continue
        if hasattr(value, "isoformat"):
            try:
                payload[text_key] = value.isoformat()
                continue
            except TypeError:
                pass
        if isinstance(value, (int, float, bool, str)):
            payload[text_key] = value
        else:
            payload[text_key] = str(value)
    return payload


# ─── Date parsing ────────────────────────────────────────────────────────────


def parse_yyyy_mm_dd(value: str, field_name: str = "date") -> date:
    text = (value or "").strip()
    try:
        return datetime.strptime(text, "%Y-%m-%d").date()
    except ValueError as exc:
        raise ValueError(f"{field_name} must be YYYY-MM-DD") from exc


def restore_original_filename(upload_file_id: str | None) -> str | None:
    """Strip 32-char hex prefix (hash) from upload file IDs to get original name."""
    value = (upload_file_id or "").strip()
    if not value:
        return None
    match = re.match(r"^[0-9a-f]{32}_(.+)$", value, re.IGNORECASE)
    if match:
        restored = match.group(1).strip()
        if restored:
            return restored
    return value
