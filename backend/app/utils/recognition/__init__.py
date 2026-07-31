"""Shared recognition module for report type and country detection.

Entry point: recognize_file()
"""

from app.utils.recognition.recognizers import (
    recognize_file,
    recognize_inventory_report,
    recognize_inventory_ledger,
    recognize_sales_report,
    recognize_business_report,
    recognize_payment_report,
    recognize_return_report,
)
from app.utils.recognition.models import RecognitionResult
from app.utils.recognition.patterns import (
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
    _normalize_columns,
    _normalize_identifier,
    _normalize_country,
    _extract_date_from_filename,
)
