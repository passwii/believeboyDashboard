"""Regression tests: financial-series row/trend must propagate VAT fields.

Covers `app.services.report.pt4._build_financial_row`,
`app.services.report.utils._empty_financial_row`, and
`app.services.report.pt4._build_trend_point` — the three helpers that
feed the `GET /api/v1/monthly-reports/financial-series` response.

Schema ownership (locked by alembic 160/161):
- PT3 owns income-side VAT: ``income_vat_total``, ``income_sales_with_tax``.
- PT4 owns expense-side VAT: ``expense_vat_total``.

BEL-125 v3: previously the helper read income-side VAT from ``pt4`` via
``getattr(pt4, ...)`` which always returned ``None`` (PT4 has no such
columns), so the API returned ``income_sales_with_tax: 0`` for every
report. The fix routes income-side VAT reads through the new ``pt3`` arg.
"""
from decimal import Decimal

from app.services.report.pt4 import _build_financial_row, _build_trend_point
from app.services.report.utils import _empty_financial_row


class _StubPT4:
    """Minimal stand-in for ``MonthlyReportPT4Calculation``.

    Only carries expense-side VAT (``expense_vat_total``, alembic 161)
    plus the standard income/expense breakdown columns. No income-side
    VAT columns by design — matches the real schema.
    """

    income_sales = Decimal("100.00")
    income_refund = Decimal("0")
    income_adjustment = Decimal("0")
    income_other = Decimal("0")
    expense_selling_fee = Decimal("10.00")
    expense_fba_fee = Decimal("0")
    expense_inventory_fee = Decimal("0")
    expense_service_fee = Decimal("0")
    expense_advertising = Decimal("0")
    expense_other_fees = Decimal("0")
    income_total = Decimal("100.00")  # net only; gross lives on PT3
    expense_total = Decimal("-10.00")
    amazon_pay_back = Decimal("80.00")
    expense_vat_total = Decimal("20.00")
    credit_card_deduction_usd = Decimal("0")


class _StubPT3:
    """Stand-in for ``MonthlyReportPT3Calculation`` carrying the income
    VAT columns added by alembic 160."""

    income_vat_total = Decimal("20.00")
    income_sales_with_tax = Decimal("120.00")  # net 100 + VAT 20


class _StubPT3NoVAT:
    """PT3 row from before alembic 160 ran (or future schema drops).

    The model would not have the income VAT columns at all, so attribute
    access would raise ``AttributeError``. Simulate that by *not*
    defining the attributes.
    """


def test_build_financial_row_pt3_carries_income_vat():
    """`_build_financial_row` reads income-side VAT from PT3, expense VAT
    from PT4 (v3 contract)."""
    row = _build_financial_row("2026-04", _StubPT4(), _StubPT3())
    assert row["income_vat_total"] == 20.0
    assert row["income_sales_with_tax"] == 120.0
    assert row["expense_vat_total"] == 20.0


def test_build_financial_row_pt3_none_means_zero_income_vat():
    """When PT3 is missing (None), income-side VAT falls back to 0 — never
    leak through to the API as something derived from PT4."""
    row = _build_financial_row("2026-04", _StubPT4(), None)
    assert row["income_vat_total"] == 0.0
    assert row["income_sales_with_tax"] == 0.0
    # expense VAT still comes from PT4 unchanged
    assert row["expense_vat_total"] == 20.0


def test_build_financial_row_us_pt3_with_real_net_sales():
    """US: PT3.income_sales_with_tax = net (per v2 PR 90 / alembic 165
    backfill). Helper must propagate the net value through to the row
    so the frontend can render without country branching."""
    class _PT3US(_StubPT3):
        income_vat_total = Decimal("0")
        income_sales_with_tax = Decimal("100.00")  # net, no VAT

    row = _build_financial_row("2026-04", _StubPT4(), _PT3US())
    assert row["income_sales_with_tax"] == 100.0
    assert row["income_vat_total"] == 0.0


def test_build_financial_row_handles_missing_vat_columns_on_pt3():
    """Older PT3 rows (or future schema drops) must not crash the helper.
    The helper uses ``getattr(pt3, ..., None) or 0`` so missing attributes
    default to 0.0 (mirroring the Pydantic schema default)."""
    row = _build_financial_row("2026-04", _StubPT4(), _StubPT3NoVAT())
    assert row["income_vat_total"] == 0.0
    assert row["income_sales_with_tax"] == 0.0
    # expense VAT still reads from PT4
    assert row["expense_vat_total"] == 20.0


def test_empty_financial_row_includes_vat_fields():
    """`_empty_financial_row` must emit the VAT keys (zeroed)."""
    row = _empty_financial_row("2026-04")
    assert row["income_vat_total"] == 0.0
    assert row["income_sales_with_tax"] == 0.0
    assert row["expense_vat_total"] == 0.0


def test_build_trend_point_includes_vat_total():
    """`_build_trend_point` should read `vat_total` from the source row."""
    source = {
        "report_month": "2026-04",
        "income_total": 120.0,
        "expense_total": -10.0,
        "amazon_pay_back": 90.0,
        "vat_total": 20.0,
        "has_source_report": True,
    }
    point = _build_trend_point(source)
    assert point["vat_total"] == 20.0
    assert point["report_month"] == "2026-04"
    assert point["net_amount"] == 110.0
