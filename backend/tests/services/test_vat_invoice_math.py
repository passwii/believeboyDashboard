from decimal import Decimal
from app.services.vat_invoice import split_vat, compute_invoice_totals


def test_split_vat_19_percent():
    out = split_vat(Decimal('119.00'), Decimal('19'))
    assert out['excl'] == Decimal('100.00')
    assert out['vat'] == Decimal('19.00')
    assert out['incl'] == Decimal('119.00')


def test_compute_invoice_totals_two_rates_plus_shipping():
    lines = [
        {'description': 'A', 'asin': 'A1', 'qty': 2,
         'unit_price_incl_vat': Decimal('119.00'), 'vat_rate': Decimal('19')},
        {'description': 'B', 'asin': 'B1', 'qty': 1,
         'unit_price_incl_vat': Decimal('120.00'), 'vat_rate': Decimal('20')},
    ]
    shipping = Decimal('10.00')  # 跟随第一行 19%

    totals = compute_invoice_totals(lines, shipping_incl_vat=shipping)

    # 行 A: incl 238.00 → excl 200.00, vat 38.00
    # 行 B: incl 120.00 → excl 100.00, vat 20.00
    # 运费 19%: excl 8.40, vat 1.60
    assert totals['subtotal_excl'] == Decimal('308.40')
    assert totals['total_vat'] == Decimal('59.60')
    assert totals['total_incl'] == Decimal('368.00')

    rows = {r['rate']: r for r in totals['summary_by_rate']}
    assert rows[Decimal('19')]['item_excl'] == Decimal('200.00')
    assert rows[Decimal('19')]['item_vat'] == Decimal('38.00')
    assert rows[Decimal('19')]['shipping_excl'] == Decimal('8.40')
    assert rows[Decimal('19')]['shipping_vat'] == Decimal('1.60')
    assert rows[Decimal('20')]['item_excl'] == Decimal('100.00')
