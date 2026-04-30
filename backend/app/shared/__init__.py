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

from app.shared.parsers import (
    SCOPE_INCLUDED,
    SCOPE_EXCLUDED_STORE,
    SCOPE_EXCLUDED_UNMAPPED,
    normalize_country,
    classify_scope,
    build_aging_status,
    is_counted_sales_status,
    match_columns,
    parse_transaction_at,
    parse_business_rows,
    parse_payment_rows,
    parse_ad_rows,
    parse_inventory_rows,
    parse_sales_rows,
    validate_inventory_rows_against_project_mapping,
)

from app.shared.persist_helpers import (
    PERIODIC_REPORT_TYPES,
    next_version,
    replace_current_pointer,
    write_report_upload_log,
)
