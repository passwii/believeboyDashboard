"""Layout regression tests for the PT3 accounting detail rows.

The dashboard / Excel export for the financial-data page shares a single
structured row list produced by `_build_accounting_rows`. The layout rules
are:

  1. The shorter side (income) is padded at the top with blank income rows
     so the detail block has a common baseline.
  2. Exactly one spacer row sits between the detail block and the totals.
  3. The bottom row carries Total_Income on the left and Total_Expense on the
     right, on the same visual line.
  4. Every row carries a `kind` discriminator ("detail" | "spacer" | "total")
     so the frontend table and the Excel "报表核算" sheet can both render
     the same structure.
"""
from types import SimpleNamespace

from app.services.report.pt3 import _build_accounting_rows


# Mirror the income / expense detail counts in pt3.py. If a future change adds
# or removes a line item, the layout tests below should still pass — only the
# derived counts in `_expected_layout` need to be updated.
_INCOME_DETAIL_COUNT = 16
_EXPENSE_DETAIL_COUNT = 20
_EXPECTED_TOTAL = _INCOME_DETAIL_COUNT + (_EXPENSE_DETAIL_COUNT - _INCOME_DETAIL_COUNT) + 1 + 1
# = 16 + 4 + 1 + 1 = 22


def _stub_pt3(
    *,
    income_total: float = 1234.5,
    expense_total: float = 678.9,
) -> SimpleNamespace:
    """PT3 stub that distinguishes the two totals from zero-valued details."""

    class _PT3:
        pass

    pt3 = _PT3()
    # Every non-total lookup returns 0.0; the totals are set explicitly so the
    # test can verify the total row receives the correct values.
    for attr in (
        "income_product_sales_non_fba",
        "income_product_sale_refunds_non_fba",
        "income_fba_product_sales",
        "income_fba_product_sale_refunds",
        "income_fba_inventory_credit",
        "income_fba_liquidation_proceeds",
        "income_shipping_credits",
        "income_shipping_credit_refunds",
        "income_gift_wrap_credits",
        "income_gift_wrap_credits_refunds",
        "income_promotional_rebates",
        "income_promotional_rebate_refunds",
        "income_a_to_z_guarantee_claims",
        "income_chargebacks",
        "income_safe_t_reimbursement",
        "income_vat_total",
    ):
        setattr(pt3, attr, 0.0)
    pt3.income_total = income_total

    for attr in (
        "expense_seller_fulfilled_selling_fees",
        "expense_fba_selling_fees",
        "expense_selling_fee_refunds",
        "expense_fba_transaction_fees",
        "expense_fba_transaction_fee_refunds",
        "expense_other_transaction_fees",
        "expense_other_transaction_fee_refunds",
        "expense_fba_inventory_and_inbound_services_fees",
        "expense_shipping_label_purchases",
        "expense_shipping_label_refunds",
        "expense_carrier_shipping_label_adjustments",
        "expense_service_fees",
        "expense_refund_administration_fees",
        "expense_adjustments",
        "expense_cost_of_advertising",
        "expense_refund_for_advertiser",
        "expense_liquidations_fees",
        "expense_receivables",
        "expense_deductions",
        "expense_amazon_shipping_charge_adjustments",
    ):
        setattr(pt3, attr, 0.0)
    pt3.expense_total = expense_total
    return pt3


def _expected_layout():
    """Return the expected (income_pad, detail_count)."""
    income_pad = max(0, _EXPENSE_DETAIL_COUNT - _INCOME_DETAIL_COUNT)
    return income_pad, _INCOME_DETAIL_COUNT


def test_build_accounting_rows_emits_kind_discriminator():
    """Every row must carry a `kind` in {detail, spacer, total}."""
    rows = _build_accounting_rows(_stub_pt3(), country="US")
    assert rows
    kinds = {row["kind"] for row in rows}
    assert kinds == {"detail", "spacer", "total"}


def test_build_accounting_rows_total_row_count():
    """There must be exactly one spacer and one total row at the bottom."""
    rows = _build_accounting_rows(_stub_pt3(), country="US")
    assert rows[-1]["kind"] == "total"
    assert rows[-2]["kind"] == "spacer"
    assert sum(1 for r in rows if r["kind"] == "spacer") == 1
    assert sum(1 for r in rows if r["kind"] == "total") == 1


def test_build_accounting_rows_income_pad_count():
    """Income side should be padded at the top to align with the expense side."""
    rows = _build_accounting_rows(_stub_pt3(), country="US")
    income_pad, _ = _expected_layout()
    # The first `income_pad` rows must be padding: blank income, real expense.
    for i in range(income_pad):
        padded = rows[i]
        assert padded["kind"] == "detail"
        assert padded["income_en"] == ""
        assert padded["income_zh"] == ""
        assert padded["income_amount_usd"] == 0.0
        assert padded["expense_en"] != "", (
            f"pad row {i} must carry a real expense label"
        )
    # The first row after the pad is the first income line item, not a
    # leftover blank from the pad.
    assert rows[income_pad]["income_en"] == "Product sales (non-FBA)"
    assert rows[income_pad]["kind"] == "detail"


def test_build_accounting_rows_aligned_detail_block():
    """After the pad, the income and expense columns share the same row index."""
    rows = _build_accounting_rows(_stub_pt3(), country="US")
    income_pad, income_detail = _expected_layout()
    # The aligned block starts at `income_pad` and runs for `income_detail` rows.
    for offset in range(income_detail):
        r = rows[income_pad + offset]
        assert r["kind"] == "detail"
        # Income column is real for the whole aligned block.
        assert r["income_en"] != "", (
            f"aligned row {offset} must carry a real income label"
        )
    # The last income detail row is the last income line item.
    last_income_row = rows[income_pad + income_detail - 1]
    assert last_income_row["income_en"] == "Product sales tax (gross)"
    # The last detail row carries the last expense line item.
    last_detail_row = rows[income_pad + income_detail - 1]
    assert last_detail_row["expense_en"] == "Amazon Shipping Charge Adjustments"


def test_build_accounting_rows_total_row_uses_totals():
    """The total row must carry Total_Income / Total_Expense and the totals."""
    pt3 = _stub_pt3(income_total=111.11, expense_total=222.22)
    rows = _build_accounting_rows(pt3, country="US")
    total = rows[-1]
    assert total["kind"] == "total"
    assert total["income_en"] == "Total_Income"
    assert total["income_zh"] == "合计销售额"
    assert total["income_amount_usd"] == 111.11
    assert total["expense_en"] == "Total_Expense"
    assert total["expense_zh"] == "合计费用"
    assert total["expense_amount_usd"] == 222.22


def test_build_accounting_rows_spacer_is_blank():
    """The spacer row must be entirely empty except for the kind/currency markers."""
    rows = _build_accounting_rows(_stub_pt3(), country="US")
    spacer = rows[-2]
    assert spacer["kind"] == "spacer"
    for key in (
        "income_en",
        "income_zh",
        "income_source",
        "expense_en",
        "expense_zh",
        "expense_source",
    ):
        assert spacer[key] == "", f"spacer {key} should be empty"
    assert spacer["income_amount_usd"] == 0.0
    assert spacer["expense_amount_usd"] == 0.0


def test_build_accounting_rows_currency_code_preserved_through_layout():
    """BEL-43 currency_code must remain on every row, including spacer and total."""
    rows = _build_accounting_rows(_stub_pt3(), country="DE")
    assert all(r["currency_code"] == "EUR" for r in rows)
    # Same for UK.
    rows = _build_accounting_rows(_stub_pt3(), country="UK")
    assert all(r["currency_code"] == "GBP" for r in rows)
    # Legacy (no country) still works.
    rows = _build_accounting_rows(_stub_pt3())
    assert all(r["currency_code"] == "USD" for r in rows)


def test_build_accounting_rows_total_count():
    """Sanity check: the layout is stable and not over- or under-emitting rows."""
    rows = _build_accounting_rows(_stub_pt3(), country="US")
    assert len(rows) == _EXPECTED_TOTAL
