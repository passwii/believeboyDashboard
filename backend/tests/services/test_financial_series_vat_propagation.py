"""Regression tests: financial-series row/trend must propagate VAT fields.

Covers `app.services.report.pt4._build_financial_row`,
`app.services.report.utils._empty_financial_row`, and
`app.services.report.pt4._build_trend_point` — the three helpers that
feed the `GET /api/v1/monthly-reports/financial-series` response.

Before the fix these helpers omitted `income_vat_total`,
`income_sales_with_tax`, and `expense_vat_total` from the per-month
row dict and the trend point, so the frontend's new VAT column would
always read 0 even for DE/UK reports.
"""
from decimal import Decimal

from app.services.report.pt4 import _build_financial_row, _build_trend_point
from app.services.report.utils import _empty_financial_row


class _StubPT4:
    """Minimal stand-in for `MonthlyReportPT4Calculation` carrying the
    VAT columns added by alembic 160/161."""

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
    income_total = Decimal("120.00")  # net 100 + VAT 20
    expense_total = Decimal("-10.00")
    amazon_pay_back = Decimal("90.00")
    income_vat_total = Decimal("20.00")
    income_sales_with_tax = Decimal("120.00")
    expense_vat_total = Decimal("20.00")
    credit_card_deduction_usd = Decimal("0")


def test_build_financial_row_includes_vat_fields():
    """`_build_financial_row` must propagate VAT values from PT4."""
    row = _build_financial_row("2026-04", _StubPT4())
    assert row["income_vat_total"] == 20.0
    assert row["income_sales_with_tax"] == 120.0
    assert row["expense_vat_total"] == 20.0


class _StubPT4NoVAT:
    """Stand-in for a PT4 row from before alembic 160/161 ran.

    The model would not have the VAT columns at all, so attribute access
    on a SQLAlchemy ORM instance would raise `AttributeError`. Simulate
    that by *not* defining the attributes on this stub.
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
    income_total = Decimal("100.00")
    expense_total = Decimal("-10.00")
    amazon_pay_back = Decimal("80.00")
    credit_card_deduction_usd = Decimal("0")


def test_build_financial_row_handles_missing_vat_columns():
    """Older PT4 rows (or future schema drops) must not crash the helper.

    Use a stub where the VAT columns are missing — the helper should
    default to 0.0 (mirroring the Pydantic schema default).
    """
    row = _build_financial_row("2026-04", _StubPT4NoVAT())
    assert row["income_vat_total"] == 0.0
    assert row["income_sales_with_tax"] == 0.0
    assert row["expense_vat_total"] == 0.0


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
