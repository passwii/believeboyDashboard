"""Regression test for BEL-299: the Excel number format for currency amounts
must render the report's country currency symbol (€/£) instead of always a
dollar sign.

The 报表核算 summary totals (columns 3 & 8) and any caller of
``_excel_num_fmt("currency_usd", currency_code)`` must pick the symbol from
the currency code, matching the per-country currency already shown in headers.
"""
from decimal import Decimal

from openpyxl import Workbook

from app.services.report.export import (
    _excel_num_fmt,
    _style_accounting_summary_rows,
)


def test_excel_num_fmt_usd_default_is_dollar():
    assert _excel_num_fmt("currency_usd") == '"$"#,##0.00;[Red]-"$"#,##0.00'


def test_excel_num_fmt_eur_uses_euro_sign():
    assert _excel_num_fmt("currency_usd", "EUR") == '"€"#,##0.00;[Red]-"€"#,##0.00'


def test_excel_num_fmt_gbp_uses_pound_sign():
    assert _excel_num_fmt("currency_usd", "GBP") == '"£"#,##0.00;[Red]-"£"#,##0.00'


def test_excel_num_fmt_unknown_currency_falls_back_to_usd():
    assert (
        _excel_num_fmt("currency_usd", "ZZZ") == '"$"#,##0.00;[Red]-"$"#,##0.00'
    )


def test_excel_num_fmt_rmb_unchanged():
    assert _excel_num_fmt("currency_rmb") == "¥#,##0.00;[Red]-¥#,##0.00"
    assert _excel_num_fmt("currency_rmb_nullable") == "¥#,##0.00;[Red]-¥#,##0.00"


def _total_row() -> dict:
    return {
        "kind": "total",
        "income_en": "Income",
        "income_zh": "收入",
        "income_amount_usd": Decimal("100"),
        "income_source": "",
        "expense_en": "Expense",
        "expense_zh": "支出",
        "expense_amount_usd": Decimal("50"),
        "expense_source": "",
    }


def test_style_summary_rows_eur_for_de():
    ws = Workbook().active
    _style_accounting_summary_rows(ws, [_total_row()], currency_code="EUR")
    assert ws.cell(2, 3).number_format == '"€"#,##0.00;[Red]-"€"#,##0.00'
    assert ws.cell(2, 8).number_format == '"€"#,##0.00;[Red]-"€"#,##0.00'


def test_style_summary_rows_gbp_for_uk():
    ws = Workbook().active
    _style_accounting_summary_rows(ws, [_total_row()], currency_code="GBP")
    assert ws.cell(2, 3).number_format == '"£"#,##0.00;[Red]-"£"#,##0.00'
    assert ws.cell(2, 8).number_format == '"£"#,##0.00;[Red]-"£"#,##0.00'


def test_style_summary_rows_defaults_to_usd():
    ws = Workbook().active
    _style_accounting_summary_rows(ws, [_total_row()])
    assert ws.cell(2, 3).number_format == '"$"#,##0.00;[Red]-"$"#,##0.00'
