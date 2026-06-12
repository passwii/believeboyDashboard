"""Regression test for BEL-43 Plan C: _build_accounting_rows must stamp
the country-local currency code onto every row so the frontend can render
the correct currency symbol/label after switching country.

Before Plan C: rows only carried `income_amount_usd`/`expense_amount_usd`
(historical "USD" semantic, but the values are actually country-local
because DE/UK go through tax-inclusive aggregation without FX conversion).
The frontend was forced to keep a local country->currency switch, which
drifted from the backend's `COUNTRY_TO_CURRENCY` truth.

After Plan C: backend stamps `currency_code` per row from
`app.utils.country.get_currency(country)`, and the frontend prefers that
value over the local switch.
"""
from types import SimpleNamespace

from app.services.report.pt3 import _build_accounting_rows
from app.utils.country import get_currency


def _stub_pt3() -> SimpleNamespace:
    """Build a bare PT3-like object: every _pt3_float lookup returns 0.0."""
    return SimpleNamespace()


def test_build_accounting_rows_stamps_eur_for_de():
    rows = _build_accounting_rows(_stub_pt3(), country="DE")
    assert rows, "row list should not be empty"
    assert all(row["currency_code"] == "EUR" for row in rows)
    assert get_currency("DE") == "EUR"


def test_build_accounting_rows_stamps_gbp_for_uk():
    rows = _build_accounting_rows(_stub_pt3(), country="UK")
    assert all(row["currency_code"] == "GBP" for row in rows)
    assert get_currency("UK") == "GBP"


def test_build_accounting_rows_stamps_usd_for_us():
    rows = _build_accounting_rows(_stub_pt3(), country="US")
    assert all(row["currency_code"] == "USD" for row in rows)
    assert get_currency("US") == "USD"


def test_build_accounting_rows_defaults_to_usd_when_country_omitted():
    """Legacy callers (no country kwarg) keep historical behavior: USD."""
    rows = _build_accounting_rows(_stub_pt3())
    assert all(row["currency_code"] == "USD" for row in rows)


def test_build_accounting_rows_currency_code_matches_country():
    """Currency code must be derived from COUNTRY_TO_CURRENCY, not hardcoded."""
    for country, expected in (("US", "USD"), ("DE", "EUR"), ("UK", "GBP")):
        rows = _build_accounting_rows(_stub_pt3(), country=country)
        assert rows[0]["currency_code"] == expected, (
            f"country={country} expected {expected}, "
            f"got {rows[0]['currency_code']}"
        )


def test_build_accounting_rows_preserves_amount_field_names():
    """Backwards-compat: existing income_amount_usd/expense_amount_usd keys
    must stay on the row dict so the rest of the export/Excel path still works."""
    row = _build_accounting_rows(_stub_pt3(), country="DE")[0]
    assert "income_amount_usd" in row
    assert "expense_amount_usd" in row
    assert "income_source" in row
    assert "expense_source" in row
    assert "income_en" in row
    assert "expense_en" in row
