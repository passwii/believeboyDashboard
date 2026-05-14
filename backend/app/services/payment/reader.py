"""Payment report CSV reader.

Wrapper around services.payment.locale for reading payment report CSVs.
"""
from __future__ import annotations

from pathlib import Path

import pandas as pd

from app.services.payment.locale import read_payment_report_dataframe


def read_payment_csv(path: Path, *, country: str = "US") -> pd.DataFrame:
    """Read and parse a payment report CSV, returning a typed DataFrame.

    Args:
        path: Path to the payment report CSV file.
        country: Country code for locale-aware parsing (US, DE, UK).

    Returns:
        DataFrame with normalized columns: type, sku, quantity,
        product sales, shipping credits, promotional rebates, other,
        selling fees, fba fees, etc.
    """
    return read_payment_report_dataframe(path, country=country)
