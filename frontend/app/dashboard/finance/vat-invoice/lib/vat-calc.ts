// VAT 发票计算 — 纯函数模块
// 单一事实源：含税价。返回 excl + vat + incl。
// 精度：所有金额 round 到 0.01。

import type { InvoiceForm, InvoiceLineItem, SummaryRow, VatSplit } from '../types'

const round2 = (x: number): number => Math.round(x * 100) / 100

/** 含税价 + VAT 率(%) → {excl, vat, incl} */
export function splitVat(inclAmount: number, vatRatePct: number): VatSplit {
  const r = vatRatePct / 100
  const excl = round2(inclAmount / (1 + r))
  const vat = round2(inclAmount - excl)
  return { excl, vat, incl: round2(inclAmount) }
}

/** 单行小计：含税单价 × qty */
export function lineSubtotal(item: InvoiceLineItem): VatSplit {
  return splitVat(item.unit_price_incl_vat * item.qty, item.vat_rate)
}

/** 运费拆分：VAT 率跟随第一行商品 */
export function shippingSplit(form: InvoiceForm): VatSplit & { rate: number } {
  const rate = form.line_items[0]?.vat_rate ?? 0
  return { rate, ...splitVat(form.shipping_incl_vat, rate) }
}

const zeroRow = (rate: number): Omit<SummaryRow, 'total'> => ({
  rate,
  itemExcl: 0,
  itemVat: 0,
  shippingExcl: 0,
  shippingVat: 0,
})

/** 按 VAT 率分桶汇总（含运费归入第一行 VAT 桶） */
export function summarizeByRate(form: InvoiceForm): SummaryRow[] {
  const buckets = new Map<number, Omit<SummaryRow, 'total'>>()

  for (const item of form.line_items) {
    const sub = lineSubtotal(item)
    const b = buckets.get(item.vat_rate) ?? zeroRow(item.vat_rate)
    b.itemExcl = round2(b.itemExcl + sub.excl)
    b.itemVat = round2(b.itemVat + sub.vat)
    buckets.set(item.vat_rate, b)
  }

  if (form.line_items.length > 0) {
    const ship = shippingSplit(form)
    const b = buckets.get(ship.rate) ?? zeroRow(ship.rate)
    b.shippingExcl = round2(b.shippingExcl + ship.excl)
    b.shippingVat = round2(b.shippingVat + ship.vat)
    buckets.set(ship.rate, b)
  }

  return [...buckets.values()]
    .sort((a, b) => a.rate - b.rate)
    .map((b) => ({
      ...b,
      total: round2(b.itemExcl + b.itemVat + b.shippingExcl + b.shippingVat),
    }))
}

/** 整张发票合计 = 所有行含税 + 运费含税 */
export function computeInvoiceTotal(form: InvoiceForm): number {
  const itemsTotal = form.line_items.reduce(
    (sum, item) => sum + round2(item.unit_price_incl_vat * item.qty),
    0
  )
  return round2(itemsTotal + form.shipping_incl_vat)
}
