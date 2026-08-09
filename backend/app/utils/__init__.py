"""Shared utilities used by both backend and autoReportUpload.

This module re-exports from submodules in app.utils/ for backward compatibility.
Consumers should import directly from submodules when possible:
    from app.utils.country import normalize_country
    from app.utils.text_utils import normalize_text
    etc.
"""

from app.utils.country import (
    normalize_country,
    get_currency,
    get_locale,
    COUNTRY_TO_CURRENCY,
    COUNTRY_TO_LOCALE,
    SUPPORTED_COUNTRIES,
)

from app.utils.utils import (
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
    restore_original_filename,
)

from app.utils.math_utils import (
    round_money,
    round_ratio,
    safe_ratio,
    change_pct,
    decimal_to_float,
    int_to_decimal,
    round_decimal,
    round_decimal_to_int,
    DECIMAL_ZERO,
)

from app.utils.text_utils import (
    normalize_text,
    normalize_identity,
    normalize_upper,
    normalize_asin,
    normalize_sku,
    normalize_slug,
)

from app.utils.date_utils import (
    parse_yyyy_mm_dd as parse_date,
    parse_yyyy_mm,
    parse_date_flexible,
    date_range,
    date_range_days,
    build_previous_period,
    build_yoy_period,
)

from app.utils.period_comparison import (
    PeriodComparison,
    build_period_comparison,
)

from app.utils.parsers import (
    SCOPE_INCLUDED,
    SCOPE_EXCLUDED_STORE,
    SCOPE_EXCLUDED_UNMAPPED,
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

from app.utils.persist_helpers import (
    PERIODIC_REPORT_TYPES,
    next_version,
    replace_current_pointer,
    write_report_upload_log,
    next_version as _next_version,
    replace_current_pointer as _replace_current_pointer,
    write_report_upload_log as _write_report_upload_log,
)

# Underscore-prefixed aliases for service compatibility
from app.utils.utils import (
    build_logical_filename as _build_logical_filename,
    build_storage_key as _build_storage_key,
    parse_yyyy_mm_dd as _parse_yyyy_mm_dd,
    project_slug as _project_slug,
    restore_original_filename as _restore_original_filename,
    sha256_file as _sha256_file,
    to_raw_row as _to_raw_row,
)

# Underscore-prefixed aliases from parsers (for product submodule compatibility)
from app.utils.parsers import (
    parse_ad_rows as _parse_ad_rows,
    parse_business_rows as _parse_business_rows,
    parse_inventory_rows as _parse_inventory_rows,
    parse_payment_rows as _parse_payment_rows,
    parse_sales_rows as _parse_sales_rows,
    validate_inventory_rows_against_project_mapping as _validate_inventory_rows_against_project_mapping,
)