"""Payment report service layer.

Unified business logic for payment report processing.
All consumers should import from here, not from shared.payment_locale directly.
"""
from app.services.payment.reader import read_payment_csv
from app.services.payment.classifier import classify_rows
from app.services.payment.aggregate import build_sku_aggregate
from app.services.payment.financial import compute_metrics
from app.services.payment.db_reader import build_df_from_source, build_df_from_sources
from app.services.payment.validation import validate_project_match
from app.services.payment.parsing import parse_to_db_rows

# Alias for backward compatibility with financial.payment_report consumers
validate_payment_report_project_match = validate_project_match

__all__ = [
    "read_payment_csv",
    "classify_rows",
    "build_sku_aggregate",
    "compute_metrics",
    "build_df_from_source",
    "build_df_from_sources",
    "validate_project_match",
    "validate_payment_report_project_match",  # alias
    "parse_to_db_rows",
]
