"""Shared utilities and recognition logic used by both backend and autoReportUpload."""
from app.shared.utils import (
    normalize_text,
    normalize_identity,
    to_int,
    to_decimal,
    to_decimal_with_currency,
    sum_decimals,
    sha256_file,
    project_slug,
    build_logical_filename,
    build_storage_key,
    to_raw_row,
    parse_yyyy_mm_dd,
)
