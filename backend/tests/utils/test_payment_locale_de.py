"""Regression tests for German (DE) payment report type/description aliases.

The DE payment report CSV ships with German-locale type and description
columns. Before the alias additions in this module was introduced, a
typical "lost in warehouse" reimbursement row used the type
``Anpassung`` and the description ``Versand durch Amazon Erstattung
für Lagerbestand - Im Lager verloren`` — both unrecognised, so the
classifier dropped the row entirely and the credit never reached
``fba_inventory_credit``.
"""
from app.utils.payment_locale import (
    normalize_payment_description,
    normalize_payment_type,
)


class TestGermanTypeAliases:
    """``Anpassung`` must normalise to the canonical ``Adjustment`` type."""

    def test_anpassung_maps_to_adjustment(self):
        assert normalize_payment_type('Anpassung') == 'Adjustment'

    def test_lowercase_anpassung_maps_to_adjustment(self):
        # CSV readers may downcase; the alias is compared against the
        # normalised (lower-cased, umlaut-stripped) token.
        assert normalize_payment_type('anpassung') == 'Adjustment'

    def test_english_adjustment_still_works(self):
        assert normalize_payment_type('Adjustment') == 'Adjustment'


class TestGermanDescriptionAliases:
    """``Versand durch Amazon Erstattung für Lagerbestand - Im Lager verloren``."""

    def test_lost_in_warehouse_normalises_to_lost_canonical(self):
        de = 'Versand durch Amazon Erstattung für Lagerbestand - Im Lager verloren'
        assert (
            normalize_payment_description(de, locale='de')
            == 'FBA Inventory Reimbursement - Lost'
        )

    def test_english_lost_still_routes_via_substring_branch(self):
        # English ``lost:warehouse`` is matched by the substring branch in
        # normalize_payment_description, not the new static alias. Make sure
        # adding the static alias did not regress this path.
        assert (
            normalize_payment_description(
                'FBA inventory reimbursement - lost:warehouse', locale='en'
            )
            == 'FBA Inventory Reimbursement - Lost'
        )

    def test_general_adjustment_german_alias_still_works(self):
        # The pre-existing ``allgemeine anpassung`` alias must keep
        # returning the General Adjustment canonical, not the new Lost one.
        de = 'FBA-Bestandsentschädigung - Allgemeine Anpassung'
        assert (
            normalize_payment_description(de, locale='de')
            == 'FBA Inventory Reimbursement - General Adjustment'
        )
