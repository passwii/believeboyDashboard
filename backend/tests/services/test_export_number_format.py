"""Tests for export-side number_format wiring.

The Excel export must render long-tail floats (e.g. 0.3333333) at sane
precision: 2dp for currency, 4dp for exchange rate, 2dp for percent. These
tests guard the two parts of that contract:

  1. ``infer_column_number_format`` correctly maps a header name to an
     Excel format string for the column types we care about.
  2. ``rows_to_sheet`` actually applies the resolved format to each data
     cell, so the format string travels from the column definition down
     into the openpyxl cell.
  3. ``apply_column_formats`` patches an already-written sheet (the path
     pandas-driven exports use via ``dataframe_to_rows``).
"""
from openpyxl import Workbook

from app.services.excel_format import (
    apply_column_formats,
    excel_num_fmt,
    infer_column_number_format,
    rows_to_sheet,
)


# --------------------------------------------------------------------------- #
# infer_column_number_format
# --------------------------------------------------------------------------- #


def test_infer_rate_columns_use_4dp():
    assert infer_column_number_format("exchange_rate") == "0.0000"
    assert infer_column_number_format("exchangeRate") == "0.0000"
    assert infer_column_number_format("usd_to_rmb_rate") == "0.0000"


def test_infer_usd_columns_use_currency_format():
    expected = excel_num_fmt("currency_usd")
    assert infer_column_number_format("amount_usd") == expected
    assert infer_column_number_format("usd_amount") == expected
    assert infer_column_number_format("net_profit_usd") == expected
    assert infer_column_number_format("income_total_usd_value") == expected


def test_infer_rmb_columns_use_currency_format():
    expected = excel_num_fmt("currency_rmb")
    assert infer_column_number_format("amount_rmb") == expected
    assert infer_column_number_format("fob_cost_rmb") == expected


def test_infer_percent_columns_use_2dp_percent():
    # 0.00% is the post-refactor format (was 0.0% before, which was 1dp).
    assert infer_column_number_format("refund_ratio") == "0.00%"
    assert infer_column_number_format("platformRatio") == "0.00%"
    assert infer_column_number_format("conversion_rate") == "0.00%"


def test_infer_unknown_column_returns_none():
    # Non-numeric / unrecognised headers should fall back to openpyxl's
    # default General format — we don't pretend to know.
    assert infer_column_number_format("monthLabel") is None
    assert infer_column_number_format("sku") is None
    assert infer_column_number_format("") is None


def test_infer_currency_code_propagates_to_usd_format():
    """A DE report should render ``sales_usd`` with ``€``, not ``$``."""
    eur = infer_column_number_format("sales_usd", currency_code="EUR")
    assert "€" in eur
    assert "$" not in eur


# --------------------------------------------------------------------------- #
# rows_to_sheet applies number_format to data cells
# --------------------------------------------------------------------------- #


def _col(sheet, header, rows):
    """Return the 1-based column index of ``header`` in the sheet's header row."""
    header_row = list(sheet.iter_rows(min_row=1, max_row=1, values_only=True))[0]
    return header_row.index(header) + 1


def test_rows_to_sheet_applies_currency_format_to_usd_column():
    rows = [
        {"sku": "ABC", "amount_usd": 0.3333333, "monthLabel": "2026-07"},
        {"sku": "DEF", "amount_usd": 66.6666667, "monthLabel": "2026-08"},
    ]
    ws = Workbook().active
    rows_to_sheet(ws, rows)

    col = _col(ws, "amount_usd", rows)
    expected = excel_num_fmt("currency_usd")
    for sheet_row in (2, 3):
        cell = ws.cell(sheet_row, col)
        # Value preserved, only presentation rounded.
        assert cell.value in (0.3333333, 66.6666667)
        assert cell.number_format == expected


def test_rows_to_sheet_applies_4dp_to_exchange_rate_column():
    rows = [{"exchangeRate": 7.123456789, "monthLabel": "2026-07"}]
    ws = Workbook().active
    rows_to_sheet(ws, rows)

    col = _col(ws, "exchangeRate", rows)
    cell = ws.cell(2, col)
    assert cell.value == 7.123456789
    assert cell.number_format == "0.0000"


def test_rows_to_sheet_applies_percent_format_to_ratio_column():
    rows = [{"refund_ratio": 0.3333333, "monthLabel": "2026-07"}]
    ws = Workbook().active
    rows_to_sheet(ws, rows)

    col = _col(ws, "refund_ratio", rows)
    cell = ws.cell(2, col)
    assert cell.value == 0.3333333
    assert cell.number_format == "0.00%"


def test_rows_to_sheet_explicit_column_format_overrides_heuristic():
    """Explicit ``column_formats`` wins over header-name inference so callers
    can pin a different format when the header name is misleading."""
    rows = [{"amount_usd": 0.5}]
    ws = Workbook().active
    rows_to_sheet(ws, rows, column_formats={"amount_usd": "0.000000"})
    col = _col(ws, "amount_usd", rows)
    assert ws.cell(2, col).number_format == "0.000000"


def test_rows_to_sheet_currency_code_propagates():
    rows = [{"sales_usd": 0.5}]
    ws = Workbook().active
    rows_to_sheet(ws, rows, currency_code="EUR")
    col = _col(ws, "sales_usd", rows)
    assert "€" in ws.cell(2, col).number_format


def test_rows_to_sheet_leaves_unknown_columns_alone():
    """Columns we don't recognise should keep openpyxl's default format —
    we don't want to surprise a textual or date column with a numeric format."""
    rows = [{"sku": "ABC-1", "amount_usd": 12.5}]
    ws = Workbook().active
    rows_to_sheet(ws, rows)
    col = _col(ws, "sku", rows)
    # openpyxl's default for a fresh cell is "General".
    assert ws.cell(2, col).number_format == "General"


def test_rows_to_sheet_empty_rows_writes_placeholder():
    """Empty rows still emit a No Data placeholder so downstream style passes
    don't blow up on a 0-row sheet."""
    ws = Workbook().active
    rows_to_sheet(ws, [])
    assert ws.cell(1, 1).value == "No Data"


# --------------------------------------------------------------------------- #
# apply_column_formats: the pandas-driven path
# --------------------------------------------------------------------------- #


def test_apply_column_formats_patches_dataframe_written_sheet():
    """Pandas-driven callers write their own cells via ``dataframe_to_rows``
    and then call ``apply_column_formats`` to stamp the right number_format
    on every data cell. This is the path product_analysis.py uses."""
    from openpyxl.utils.dataframe import dataframe_to_rows

    ws = Workbook().active
    headers = ["SKU", "广告花费", "退款率"]
    # Header + 2 data rows, mimicking what dataframe_to_rows writes.
    data = [
        headers,
        ["SKU-1", 123.456789, 0.0666667],
        ["SKU-2", 0.3333333, 0.1234567],
    ]
    for r_idx, row in enumerate(data, 1):
        for c_idx, value in enumerate(row, 1):
            ws.cell(row=r_idx, column=c_idx, value=value)

    apply_column_formats(ws, headers)

    # Column A (SKU) → no format (text)
    assert ws.cell(2, 1).number_format == "General"
    # Column B (广告花费) → heuristic doesn't match Chinese header; the
    # caller is expected to pass column_formats for these. Re-run with
    # the override map to verify the override path.
    apply_column_formats(
        ws,
        headers,
        column_formats={"广告花费": excel_num_fmt("currency_usd"), "退款率": "0.00%"},
    )
    assert ws.cell(2, 2).number_format == excel_num_fmt("currency_usd")
    assert ws.cell(3, 2).number_format == excel_num_fmt("currency_usd")
    assert ws.cell(2, 3).number_format == "0.00%"
    assert ws.cell(3, 3).number_format == "0.00%"


def test_apply_column_formats_uses_heuristic_for_known_headers():
    """``apply_column_formats`` should still consult the heuristic when no
    override is passed — that's the whole point of centralising the rules."""
    ws = Workbook().active
    headers = ["sales_usd", "amount_rmb", "exchange_rate"]
    data = [headers, [0.5, 0.5, 7.123456789]]
    for r_idx, row in enumerate(data, 1):
        for c_idx, value in enumerate(row, 1):
            ws.cell(row=r_idx, column=c_idx, value=value)

    apply_column_formats(ws, headers)

    assert "$" in ws.cell(2, 1).number_format
    assert "¥" in ws.cell(2, 2).number_format
    assert ws.cell(2, 3).number_format == "0.0000"


def test_apply_column_formats_skips_empty_cells():
    """Sparse data shouldn't be stamped with a numeric format when the value
    is None or empty — openpyxl writes ``None`` for missing values and we
    want those to stay at the default format."""
    ws = Workbook().active
    headers = ["sales_usd"]
    data = [headers, [None], [""], [0.5]]
    for r_idx, row in enumerate(data, 1):
        for c_idx, value in enumerate(row, 1):
            ws.cell(row=r_idx, column=c_idx, value=value)

    apply_column_formats(ws, headers)

    assert ws.cell(2, 1).number_format == "General"
    assert ws.cell(3, 1).number_format == "General"
    assert "$" in ws.cell(4, 1).number_format


def test_apply_column_formats_noop_when_sheet_empty():
    """If the sheet has no data rows, ``apply_column_formats`` should be a
    no-op rather than crashing on ``ws.max_row < start_row``."""
    ws = Workbook().active
    ws.append(["sales_usd"])
    apply_column_formats(ws, ["sales_usd"])
    # Header still untouched.
    assert ws.cell(1, 1).number_format == "General"
