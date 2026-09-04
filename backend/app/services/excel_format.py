"""Shared Excel number-format helpers.

All backend Excel export entry points (monthly financial report, category
research workbook, product analysis script, PT3 reconciliation export) route
their numeric cells through the helpers in this module so they pick up a
single set of conventions:

  - currency amounts  → 2dp with the country symbol (USD $, EUR €, GBP £)
  - exchange rates     → 4dp (the project's high-precision rule)
  - percent / ratio    → 2dp ``0.00%`` (source values are 0..1 fractions)

The convention is enforced at the ``number_format`` layer: the underlying
cell value stays a float / Decimal so the file can still be summed or used
in formulas. We never round the value to a string — only the presentation.

Helpers
-------
- :func:`excel_num_fmt`  — format-key → Excel format string
- :func:`infer_column_number_format`  — header-name → Excel format string
- :func:`rows_to_sheet`  — write a list[dict] to a worksheet with formats
- :func:`apply_column_formats`  — patch an already-written worksheet's data cells
"""
from __future__ import annotations

from typing import Iterable, Mapping


# Per-country currency symbol used by the ``currency_usd`` number format.
# The In/Ex amount columns in monthly reports are denominated in the report's
# country currency, not necessarily USD, so the format must render €/£ for
# DE/UK reports.
_CURRENCY_SYMBOL_BY_CODE = {"USD": "$", "EUR": "€", "GBP": "£"}


def excel_num_fmt(format_key: str, currency_code: str = "USD") -> str | None:
    """Return the Excel number_format string for a logical format key.

    Args:
        format_key: One of ``currency_usd``, ``currency_rmb``,
            ``currency_rmb_nullable``, ``percent``, ``percent_signed``,
            ``rate``. Unknown keys return ``None`` so callers can fall
            through to their default.
        currency_code: ISO currency code (USD/EUR/GBP) used for the
            ``currency_usd`` format key so the rendered symbol matches the
            report's country instead of always being a dollar sign.

    Returns:
        Excel format string (e.g. ``'"$"#,##0.00;[Red]-"$"#,##0.00'``) or
        ``None`` for unrecognised keys.
    """
    if format_key == "currency_usd":
        symbol = _CURRENCY_SYMBOL_BY_CODE.get(currency_code, "$")
        return f'"{symbol}"#,##0.00;[Red]-"{symbol}"#,##0.00'
    if format_key in ("currency_rmb", "currency_rmb_nullable"):
        return "¥#,##0.00;[Red]-¥#,##0.00"
    if format_key in ("percent", "percent_signed"):
        # Two decimals behind the percent sign, per export convention
        # (e.g. 0.3333 -> 33.33%). Source values are 0..1 fractions.
        return "0.00%"
    if format_key == "rate":
        # Four decimals for exchange rates — these are the canonical
        # high-precision fields and the rest of the codebase treats them
        # as 4dp.
        return "0.0000"
    return None


def infer_column_number_format(
    header: str,
    *,
    currency_code: str = "USD",
) -> str | None:
    """Infer an Excel number_format for a column whose semantics we recognise.

    Dynamic detail sheets (transactions, SKU roll-ups, etc.) have
    heterogeneous columns, so we can't ship a fixed per-sheet format map.
    Instead, fall back to a header-name heuristic. Callers can still pass an
    explicit ``column_formats`` map to override.

    Conventions:
      - exchange rate columns → 0.0000 (4dp, the project's high-precision rule)
      - *_usd / *_USD columns  → currency_usd (2dp, dollar/€/£ per row country)
      - *_rmb / *_RMB columns  → currency_rmb (2dp)
      - columns ending in _pct / _rate / ratio* → 0.00% (2dp; source is 0..1)
    Anything we don't recognise returns None and the cell keeps openpyxl's
    default General format.

    Args:
        header: Column header text.
        currency_code: ISO code passed through to :func:`excel_num_fmt` for
            currency columns. Use the report's country so a DE report's
            ``sales_usd`` renders with ``€``, not ``$``.

    Returns:
        Excel format string or ``None``.
    """
    lowered = header.strip().lower()
    if not lowered:
        return None
    # Exchange-rate columns: explicit set first (cheap), then the heuristic.
    if lowered in {"exchange_rate", "exchangerate", "usd_to_rmb_rate"} or (
        "exchange" in lowered and "rate" in lowered
    ):
        return "0.0000"
    if (
        lowered.startswith("usd_")
        or lowered.endswith("_usd")
        or lowered == "usd"
        or "_usd_" in lowered
    ):
        return excel_num_fmt("currency_usd", currency_code)
    if (
        lowered.startswith("rmb_")
        or lowered.endswith("_rmb")
        or lowered == "rmb"
        or "_rmb_" in lowered
    ):
        return excel_num_fmt("currency_rmb")
    if (
        lowered.endswith("_pct")
        or lowered.endswith("_rate")
        or lowered.startswith("ratio")
        or lowered.endswith("ratio")
    ):
        return "0.00%"
    return None


def resolve_column_formats(
    headers: Iterable[str],
    *,
    column_formats: Mapping[str, str] | None = None,
    currency_code: str = "USD",
) -> list[str | None]:
    """Resolve the format string for each header in display order.

    Resolution order, per column:
      1. Explicit ``column_formats`` override (caller-provided map wins).
      2. :func:`infer_column_number_format` heuristic.
      3. ``None`` — caller should leave the cell at openpyxl's default
         ``General`` format.

    Args:
        headers: Header strings in the order they appear on the sheet.
        column_formats: Optional explicit per-column overrides keyed by
            header.
        currency_code: ISO code passed through to the heuristic for
            currency columns.

    Returns:
        A list parallel to ``headers`` with each entry being either an
        Excel format string or ``None``.
    """
    resolved: list[str | None] = []
    for header in headers:
        if column_formats and header in column_formats:
            resolved.append(column_formats[header])
        else:
            resolved.append(infer_column_number_format(header, currency_code=currency_code))
    return resolved


def apply_column_formats(
    ws,
    headers: list[str],
    *,
    column_formats: Mapping[str, str] | None = None,
    currency_code: str = "USD",
    start_row: int = 2,
    skip_empty: bool = True,
) -> None:
    """Apply per-column number_format to the data rows of ``ws``.

    Assumes row 1 is the header and rows ``start_row..ws.max_row`` are data.
    Used by callers that have already written the data and just want the
    format pass afterwards (e.g. pandas-driven ``dataframe_to_rows`` loops).

    Args:
        ws: openpyxl worksheet.
        headers: Header strings in display order (length must equal
            ``ws.max_column``).
        column_formats: Optional explicit per-column overrides.
        currency_code: ISO code passed through to the heuristic.
        start_row: First data row. Defaults to 2 (sheet row 1 = header).
        skip_empty: If True, don't touch cells whose value is ``None`` or
            empty string — keeps the default General format on sparse data.
    """
    if ws.max_row < start_row:
        return
    resolved = resolve_column_formats(
        headers, column_formats=column_formats, currency_code=currency_code
    )
    for r in range(start_row, ws.max_row + 1):
        for c, fmt in enumerate(resolved, start=1):
            if fmt is None:
                continue
            cell = ws.cell(r, c)
            if skip_empty and (cell.value is None or cell.value == ""):
                continue
            cell.number_format = fmt


def rows_to_sheet(
    ws,
    rows: list[Mapping[str, object]],
    *,
    column_formats: Mapping[str, str] | None = None,
    currency_code: str = "USD",
) -> None:
    """Write a list of row dicts to ``ws`` with per-cell number_format.

    Builds the header row from the union of dict keys (insertion order),
    then writes each row, then applies the resolved number_format to every
    non-empty numeric cell. Callers don't need to declare every column —
    :func:`infer_column_number_format` covers currency / rate / percent
    columns by header name.

    Args:
        ws: openpyxl worksheet.
        rows: List of row dicts. Empty list emits a ``"No Data"`` placeholder.
        column_formats: Optional explicit per-column overrides keyed by
            header.
        currency_code: ISO code passed through to the heuristic.
    """
    if not rows:
        ws.append(["No Data"])
        return
    headers: list[str] = []
    seen: set[str] = set()
    for row in rows:
        for key in row.keys():
            header = str(key)
            if header not in seen:
                seen.add(header)
                headers.append(header)
    ws.append(headers)
    resolved = resolve_column_formats(
        headers, column_formats=column_formats, currency_code=currency_code
    )
    for row in rows:
        values = [row.get(h, "") for h in headers]
        ws.append(values)
        sheet_row = ws.max_row
        for col_idx, fmt in enumerate(resolved, start=1):
            if fmt is None:
                continue
            cell = ws.cell(sheet_row, col_idx)
            if cell.value is None or cell.value == "":
                continue
            cell.number_format = fmt