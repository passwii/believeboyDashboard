"""Regression tests for the classifier's tolerance of DE-locale inputs.

The classifier historically did exact English string matching on
``row["type"]`` and ``row["description"]``. That broke the rebuild path
(``rebuild_pt3_pt4_for_report``) on historical DE data: rows whose
``raw_row`` was stored with raw German values (``Anpassung`` /
``Versand durch Amazon Erstattung für Lagerbestand - Im Lager verloren``)
were silently dropped because the if/elif chain never matched them.

The fix routes ``row_type`` and ``description`` through
``normalize_payment_type`` / ``normalize_payment_description`` at the
top of the for-loop, so historical DE raw_row values normalise to the
canonical English names and the rest of the classifier logic applies
identically.
"""
from app.services.payment.classifier import classify_rows


def _de_row(type_value: str, description: str, total: float = 12.34) -> dict:
    """Build a raw_row-shaped dict the way ``read_payment_csv`` historically
    stored DE rows in ``MonthlyReportTransaction.raw_row`` (no canonical
    normalisation applied)."""
    return {
        "type": type_value,
        "description": description,
        "fulfillment": "Amazon",
        "product sales": "0",
        "shipping credits": "0",
        "promotional rebates": "0",
        "selling fees": "0",
        "fba fees": "0",
        "other": "0",
        "other transaction fees": "0",
        "total": str(total),
    }


class TestClassifierAcceptsGermanType:
    def test_anpassung_routes_to_adjustment_branch(self):
        rows = [_de_row("Anpassung", "Some non-canonical description", total=5.0)]
        classified = classify_rows(rows)
        assert len(classified["adjustment"]) == 1
        # Lost-in-warehouse is income (positive credit to seller).
        assert len(classified["adjustment_income"]) == 1
        assert len(classified["adjustment_expense"]) == 0

    def test_english_adjustment_still_routes(self):
        rows = [_de_row("Adjustment", "FBA inventory reimbursement - lost:warehouse", total=5.0)]
        classified = classify_rows(rows)
        assert len(classified["adjustment"]) == 1
        assert len(classified["adjustment_income"]) == 1


class TestClassifierAcceptsGermanDescription:
    def test_lost_in_warehouse_description_routes_to_income(self):
        # The exact string Amazon DE emits for lost-in-warehouse
        # reimbursement. Before the fix, this string was unknown to the
        # classifier, but because the type matched ``Adjustment`` it
        # still went into adjustment_income. The point of this test is
        # to assert the same behaviour holds when the *type* is German
        # too — the historical drop bug.
        rows = [
            _de_row(
                "Anpassung",
                "Versand durch Amazon Erstattung für Lagerbestand - Im Lager verloren",
                total=8.50,
            )
        ]
        classified = classify_rows(rows)
        assert len(classified["adjustment"]) == 1
        assert len(classified["adjustment_income"]) == 1
        # The lost-in-warehouse amount must reach fba_inventory_credit.
        from app.services.payment.financial import compute_metrics
        result = compute_metrics(classified, country="DE")
        assert float(result["pt3"]["income_fba_inventory_credit"]) == 8.50

    def test_general_adjustment_german_description_routes_to_expense(self):
        # German general adjustment must still hit adjustment_expense
        # (the canonical ``FBA Inventory Reimbursement - General Adjustment``
        # is in the expense set). This guards against regressing the
        # German → canonical description mapping inside the classifier.
        rows = [
            _de_row(
                "Anpassung",
                "FBA-Bestandsentschädigung - Allgemeine Anpassung",
                total=-3.20,
            )
        ]
        classified = classify_rows(rows)
        assert len(classified["adjustment"]) == 1
        assert len(classified["adjustment_expense"]) == 1
        assert len(classified["adjustment_income"]) == 0


class TestAdjustmentOtherDescription:
    """BEL-305: ``Other`` Adjustment description must hit adjustment_expense,
    not adjustment_income. Without this carve-out, Amazon's catch-all
    "Other" adjustments (often negative) were inflating
    ``income_fba_inventory_credit`` and contaminating PT3's
    income side. The canonical English "Other" is mapped from
    ``payment_locale.PAYMENT_DESCRIPTION_ALIASES['Other']`` aliases
    (``other`` / DE ``andere``)."""

    def test_english_other_routes_to_expense(self):
        rows = [_de_row("Adjustment", "Other", total=-2.50)]
        classified = classify_rows(rows)
        assert len(classified["adjustment"]) == 1
        assert len(classified["adjustment_expense"]) == 1
        assert len(classified["adjustment_income"]) == 0

    def test_german_andere_routes_to_expense_via_normalization(self):
        rows = [_de_row("Anpassung", "Andere", total=-1.10)]
        classified = classify_rows(rows)
        assert len(classified["adjustment"]) == 1
        assert len(classified["adjustment_expense"]) == 1
        assert len(classified["adjustment_income"]) == 0

    def test_other_amount_excluded_from_fba_inventory_credit(self):
        from app.services.payment.financial import compute_metrics
        rows = [
            _de_row("Adjustment", "Other", total=-7.25),
            # Keep a positive lost-in-warehouse row to confirm the
            # expense carve-out only affects the "Other" line.
            _de_row(
                "Anpassung",
                "Versand durch Amazon Erstattung für Lagerbestand - Im Lager verloren",
                total=8.50,
            ),
        ]
        classified = classify_rows(rows)
        result = compute_metrics(classified, country="DE")
        # Only the lost-in-warehouse line should reach the FBA inventory
        # credit bucket; the negative "Other" must not cancel it.
        assert float(result["pt3"]["income_fba_inventory_credit"]) == 8.50


class TestAdjustmentBuyerRechargeDescription:
    """BEL-?: ``Buyer Recharge`` Adjustment description must hit
    adjustment_expense, not adjustment_income. Like "Other", Amazon's
    "Buyer Recharge" adjustments are not FBA inventory credits and must
    not inflate ``income_fba_inventory_credit`` on PT3's income side."""

    def test_english_buyer_recharge_routes_to_expense(self):
        rows = [_de_row("Adjustment", "Buyer Recharge", total=-4.00)]
        classified = classify_rows(rows)
        assert len(classified["adjustment"]) == 1
        assert len(classified["adjustment_expense"]) == 1
        assert len(classified["adjustment_income"]) == 0

    def test_buyer_recharge_amount_excluded_from_fba_inventory_credit(self):
        from app.services.payment.financial import compute_metrics
        rows = [
            _de_row("Adjustment", "Buyer Recharge", total=-4.00),
            # Keep a positive lost-in-warehouse row to confirm the
            # carve-out only affects the "Buyer Recharge" line.
            _de_row(
                "Anpassung",
                "Versand durch Amazon Erstattung für Lagerbestand - Im Lager verloren",
                total=8.50,
            ),
        ]
        classified = classify_rows(rows)
        result = compute_metrics(classified, country="DE")
        # Only the lost-in-warehouse line should reach the FBA inventory
        # credit bucket; the "Buyer Recharge" must not cancel it.
        assert float(result["pt3"]["income_fba_inventory_credit"]) == 8.50
