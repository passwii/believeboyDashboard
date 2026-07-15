from __future__ import annotations
from decimal import Decimal, ROUND_HALF_UP
from typing import Iterable


CENT = Decimal('0.01')


def _q(x: Decimal) -> Decimal:
    return x.quantize(CENT, rounding=ROUND_HALF_UP)


def split_vat(incl: Decimal, rate_pct: Decimal) -> dict[str, Decimal]:
    """含税价 + VAT 率(%) → {excl, vat, incl}。

    与前端 ``frontend/app/dashboard/finance/vat-invoice/lib/vat-calc.ts``
    的 ``splitVat`` 对齐：excl = round2(incl / (1 + rate/100))，
    vat = round2(incl - excl)，incl 原样返回。
    """
    r = rate_pct / Decimal(100)
    excl = _q(incl / (Decimal(1) + r))
    vat = _q(incl - excl)
    return {'excl': excl, 'vat': vat, 'incl': _q(incl)}


def _first_rate(lines: list[dict]) -> Decimal:
    return lines[0]['vat_rate'] if lines else Decimal(0)


def compute_invoice_totals(
    lines: list[dict],
    *,
    shipping_incl_vat: Decimal,
) -> dict:
    """按 VAT 率分桶聚合（含运费归入第一行 VAT 桶）。

    镜像前端 ``summarizeByRate`` + ``computeInvoiceTotal``。
    返回 ``subtotal_excl / total_vat / total_incl / summary_by_rate``。
    ``summary_by_rate`` 按 rate 升序，每行
    ``{rate, item_excl, item_vat, shipping_excl, shipping_vat, total}``。
    """
    buckets: dict[Decimal, dict] = {}
    items_total = Decimal(0)
    for it in lines:
        sub = split_vat(it['unit_price_incl_vat'] * it['qty'], it['vat_rate'])
        items_total = _q(items_total + sub['incl'])
        b = buckets.setdefault(
            it['vat_rate'],
            {
                'rate': it['vat_rate'], 'item_excl': Decimal(0), 'item_vat': Decimal(0),
                'shipping_excl': Decimal(0), 'shipping_vat': Decimal(0),
            },
        )
        b['item_excl'] = _q(b['item_excl'] + sub['excl'])
        b['item_vat'] = _q(b['item_vat'] + sub['vat'])

    if lines:
        ship = split_vat(shipping_incl_vat, _first_rate(lines))
        b = buckets.setdefault(
            _first_rate(lines),
            {
                'rate': _first_rate(lines), 'item_excl': Decimal(0), 'item_vat': Decimal(0),
                'shipping_excl': Decimal(0), 'shipping_vat': Decimal(0),
            },
        )
        b['shipping_excl'] = _q(b['shipping_excl'] + ship['excl'])
        b['shipping_vat'] = _q(b['shipping_vat'] + ship['vat'])

    summary = []
    for rate in sorted(buckets.keys()):
        b = buckets[rate]
        total = _q(b['item_excl'] + b['item_vat'] + b['shipping_excl'] + b['shipping_vat'])
        summary.append({**b, 'total': total})

    total_incl = _q(items_total + shipping_incl_vat)
    subtotal_excl = _q(Decimal(0))
    for row in summary:
        subtotal_excl = _q(subtotal_excl + row['item_excl'] + row['shipping_excl'])
    total_vat = _q(total_incl - subtotal_excl)
    return {
        'subtotal_excl': subtotal_excl,
        'total_vat': total_vat,
        'total_incl': total_incl,
        'summary_by_rate': summary,
    }
