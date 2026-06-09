// vat-calc 单元测试 — 必须先于实现编写
// 覆盖：金额精度、VAT 反算、多 VAT 率分桶、运费分摊、空行边界。

import { describe, it, expect } from "vitest"
import {
  splitVat,
  lineSubtotal,
  shippingSplit,
  summarizeByRate,
  computeInvoiceTotal,
} from "./vat-calc"
import type { InvoiceForm } from "../types"

const baseForm = (overrides: Partial<InvoiceForm> = {}): InvoiceForm => ({
  project_id: 1,
  currency: "EUR",
  order_id: "O1",
  bill_id: "B1",
  bill_hs: "9404.21",
  invoice_date: "2026-06-07",
  delivery_date: "2026-06-07",
  buyer: {
    name: "Test",
    address_line: "1 Test St",
    postal_code: "00000",
    city: "Berlin",
    country: "DE",
  },
  line_items: [],
  shipping_incl_vat: 0,
  ...overrides,
})

describe("splitVat", () => {
  it("反算 20% VAT，input 24.99 → excl 20.83 / vat 4.16 / incl 24.99", () => {
    const r = splitVat(24.99, 20)
    expect(r.excl).toBe(20.83)
    expect(r.vat).toBe(4.16)
    expect(r.incl).toBe(24.99)
  })

  it("反算 0% VAT（免税），input 等于 excl，vat 为 0", () => {
    const r = splitVat(100, 0)
    expect(r.excl).toBe(100)
    expect(r.vat).toBe(0)
    expect(r.incl).toBe(100)
  })

  it("反算 19% 德国 VAT，input 119 → excl 100 / vat 19", () => {
    const r = splitVat(119, 19)
    expect(r.excl).toBe(100)
    expect(r.vat).toBe(19)
    expect(r.incl).toBe(119)
  })

  it("反算 7% VAT，input 107 → excl 100 / vat 7", () => {
    const r = splitVat(107, 7)
    expect(r.excl).toBe(100)
    expect(r.vat).toBe(7)
    expect(r.incl).toBe(107)
  })

  it("金额精度 round 到 2 位（input 0.1 + 0.2 类型边界）", () => {
    const r = splitVat(0.3, 20)
    // 0.3 / 1.2 = 0.25; vat = 0.05; incl = 0.30
    expect(r.excl).toBe(0.25)
    expect(r.vat).toBe(0.05)
    expect(r.incl).toBe(0.3)
  })

  it("负数 input 不抛错，原样处理（视为退款场景）", () => {
    // -24.99 / 1.2 = -20.825 → round 到 -20.82
    // round2(-24.99 - (-20.82)) = round2(-4.17)
    const r = splitVat(-24.99, 20)
    expect(r.excl).toBe(-20.82)
    expect(r.vat).toBe(-4.17)
    expect(r.incl).toBe(-24.99)
  })
})

describe("lineSubtotal", () => {
  it("qty=1 × unit_incl=24.99 × 20% → excl 20.83, vat 4.16", () => {
    const r = lineSubtotal({
      description: "x",
      asin: "",
      qty: 1,
      unit_price_incl_vat: 24.99,
      vat_rate: 20,
    })
    expect(r.excl).toBe(20.83)
    expect(r.vat).toBe(4.16)
    expect(r.incl).toBe(24.99)
  })

  it("qty=3 × unit_incl=10 × 20% → excl 25, vat 5, incl 30", () => {
    const r = lineSubtotal({
      description: "x",
      asin: "",
      qty: 3,
      unit_price_incl_vat: 10,
      vat_rate: 20,
    })
    expect(r.excl).toBe(25)
    expect(r.vat).toBe(5)
    expect(r.incl).toBe(30)
  })
})

describe("shippingSplit", () => {
  it("运费 VAT 率 = 第一行商品的 VAT 率", () => {
    const form = baseForm({
      line_items: [
        { description: "x", asin: "", qty: 1, unit_price_incl_vat: 24.99, vat_rate: 20 },
      ],
      shipping_incl_vat: 10,
    })
    const r = shippingSplit(form)
    expect(r.rate).toBe(20)
    expect(r.excl).toBe(8.33)
    expect(r.vat).toBe(1.67)
    expect(r.incl).toBe(10)
  })

  it("没有商品行时，运费 VAT 率为 0", () => {
    const form = baseForm({ shipping_incl_vat: 5 })
    const r = shippingSplit(form)
    expect(r.rate).toBe(0)
    expect(r.excl).toBe(5)
    expect(r.vat).toBe(0)
  })
})

describe("summarizeByRate", () => {
  it("单行单 VAT 率 + 运费按相同率 → 一行汇总", () => {
    const form = baseForm({
      line_items: [
        { description: "x", asin: "", qty: 1, unit_price_incl_vat: 24.99, vat_rate: 20 },
      ],
      shipping_incl_vat: 0,
    })
    const rows = summarizeByRate(form)
    expect(rows).toHaveLength(1)
    expect(rows[0].rate).toBe(20)
    expect(rows[0].itemExcl).toBe(20.83)
    expect(rows[0].itemVat).toBe(4.16)
    expect(rows[0].shippingExcl).toBe(0)
    expect(rows[0].shippingVat).toBe(0)
    expect(rows[0].total).toBe(24.99)
  })

  it("多行同 VAT 率合并到同一桶", () => {
    const form = baseForm({
      line_items: [
        { description: "a", asin: "", qty: 1, unit_price_incl_vat: 10, vat_rate: 20 },
        { description: "b", asin: "", qty: 1, unit_price_incl_vat: 20, vat_rate: 20 },
      ],
    })
    const rows = summarizeByRate(form)
    expect(rows).toHaveLength(1)
    expect(rows[0].itemExcl).toBe(25)
    expect(rows[0].itemVat).toBe(5)
    expect(rows[0].total).toBe(30)
  })

  it("多行不同 VAT 率 → 多桶汇总，运费归入第一行 VAT 率桶", () => {
    const form = baseForm({
      line_items: [
        { description: "a", asin: "", qty: 1, unit_price_incl_vat: 24.99, vat_rate: 20 },
        { description: "b", asin: "", qty: 1, unit_price_incl_vat: 107, vat_rate: 7 },
      ],
      shipping_incl_vat: 10, // 跟随第一行 20%
    })
    const rows = summarizeByRate(form)
    expect(rows).toHaveLength(2)
    const r20 = rows.find((r) => r.rate === 20)!
    const r7 = rows.find((r) => r.rate === 7)!
    // 20% 桶：1 行 (24.99) + 运费 (10)
    expect(r20.itemExcl).toBe(20.83)
    expect(r20.itemVat).toBe(4.16)
    expect(r20.shippingExcl).toBe(8.33)
    expect(r20.shippingVat).toBe(1.67)
    expect(r20.total).toBe(34.99) // 24.99 + 10
    // 7% 桶：1 行 (107)
    expect(r7.itemExcl).toBe(100)
    expect(r7.itemVat).toBe(7)
    expect(r7.shippingExcl).toBe(0)
    expect(r7.shippingVat).toBe(0)
    expect(r7.total).toBe(107)
  })

  it("空行 → 空数组", () => {
    const rows = summarizeByRate(baseForm())
    expect(rows).toEqual([])
  })

  it("结果按 VAT 率升序排列", () => {
    const form = baseForm({
      line_items: [
        { description: "a", asin: "", qty: 1, unit_price_incl_vat: 10, vat_rate: 20 },
        { description: "b", asin: "", qty: 1, unit_price_incl_vat: 10, vat_rate: 7 },
        { description: "c", asin: "", qty: 1, unit_price_incl_vat: 10, vat_rate: 19 },
      ],
    })
    const rates = summarizeByRate(form).map((r) => r.rate)
    expect(rates).toEqual([7, 19, 20])
  })
})

describe("computeInvoiceTotal", () => {
  it("汇总各桶 total 之和", () => {
    const form = baseForm({
      line_items: [
        { description: "a", asin: "", qty: 1, unit_price_incl_vat: 24.99, vat_rate: 20 },
        { description: "b", asin: "", qty: 1, unit_price_incl_vat: 107, vat_rate: 7 },
      ],
      shipping_incl_vat: 10,
    })
    // 24.99 + 107 + 10 = 141.99
    expect(computeInvoiceTotal(form)).toBe(141.99)
  })

  it("空发票 → 0", () => {
    expect(computeInvoiceTotal(baseForm())).toBe(0)
  })
})
