"""Shared recognition module for report type and country detection.

Entry point: recognize_file()
"""
from app.shared.recognition.recognizers import (
    recognize_file,
    recognize_inventory_report,
    recognize_sales_report,
    recognize_business_report,
    recognize_payment_report,
    recognize_ad_product_report,
    recognize_ad_search_term_report,
    recognize_return_report,
)
from app.shared.recognition.models import RecognitionResult
from app.shared.recognition.patterns import (
    AD_PRODUCT_REPORT,
    COUNTRY_TIMEZONE,
    _date_to_string,
    _date_to_string_by_country,
    _detect_country_from_currency,
    _detect_country_from_marketplace,
    _detect_country_from_sales_amount_symbol,
    _detect_country_from_sales_channel,
    _read_csv_with_encoding_fallback,
    _read_excel,
    _read_text_with_encoding_fallback,
    _read_payment_report,
    _normalize_columns,
    _normalize_identifier,
    _normalize_country,
    _extract_date_from_filename,
)

__all__ = [
    # Entry point
    "recognize_file",
    # Per-type recognizers
    "recognize_inventory_report",
    "recognize_sales_report",
    "recognize_business_report",
    "recognize_payment_report",
    "recognize_ad_product_report",
    "recognize_ad_search_term_report",
    "recognize_return_report",
    # Models
    "RecognitionResult",
    # Patterns
    "AD_PRODUCT_REPORT",
    "COUNTRY_TIMEZONE",
    "_date_to_string",
    "_date_to_string_by_country",
    "_detect_country_from_currency",
    "_detect_country_from_marketplace",
    "_detect_country_from_sales_amount_symbol",
    "_detect_country_from_sales_channel",
    # Readers
    "_read_csv_with_encoding_fallback",
    "_read_excel",
    "_read_text_with_encoding_fallback",
    "_read_payment_report",
    # Normalizers
    "_normalize_columns",
    "_normalize_identifier",
    "_normalize_country",
    "_extract_date_from_filename",
]
