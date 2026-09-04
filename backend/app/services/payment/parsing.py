"""Payment report CSV-to-DB-row parsing.

Combines CSV reading with scope classification, producing DB-ready row dicts
for AnalysisPaymentRow bulk insert. Used by both the backend upload flow and
autoReportUpload.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from app.services.payment.reader import read_payment_csv
from app.utils.parsers import parse_payment_rows


def parse_to_db_rows(
    path: Path,
    source_file_id: int,
    known_skus: set[str],
    known_asins: set[str],
    *,
    country: str = "US",
) -> tuple[list[dict[str, Any]], int, int]:
    """Read a payment report CSV and parse into DB-ready row dicts.

    Combines CSV reading (locale-aware) with scope classification
    and row dict generation for AnalysisPaymentRow bulk insert.

    Args:
        path: Path to the payment report CSV file.
        source_file_id: Source file ID to assign to all rows.
        known_skus: Set of known SKUs for scope classification.
        known_asins: Set of known ASINs for scope classification.
        country: Country code for locale-aware parsing.

    Returns:
        Tuple of (row_dicts, total_count, included_count).
    """
    df = read_payment_csv(path, country=country)
    return parse_payment_rows(df, source_file_id, known_skus, known_asins)
