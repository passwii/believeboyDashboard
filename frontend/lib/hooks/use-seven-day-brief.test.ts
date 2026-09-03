import { describe, expect, it } from 'vitest'

import {
  aggregateWindow,
  pickLatestSalesDate,
  type SummaryRow,
} from './use-seven-day-brief'

import { pctChange } from '@/components/dashboard-v2/v2-stats'

describe('aggregateWindow（BLF-950，复用 Dashboard 首页 computeStats 模式）', () => {
  const rows: SummaryRow[] = [
    { date: '2026-09-01', sales_amount: 1200.5, order_qty: 10, pending_order_qty: 2, ad_spend: 40, ad_orders: 3 },
    { date: '2026-09-02', sales_amount: '800', order_qty: '5', pending_order_qty: '3', ad_spend: '60', ad_orders: 2 },
  ]

  it('求和 GMV / 订单 / 广告字段，Pending 取最新日（2026-09-02）', () => {
    const result = aggregateWindow(rows)
    expect(result.gmv).toBeCloseTo(2000.5)
    expect(result.orders).toBe(15)
    // Pending 取最新日期行（2026-09-02）的值
    expect(result.pending).toBe(3)
    expect(result.adSpend).toBeCloseTo(100)
    expect(result.adOrders).toBe(5)
  })

  it('空行 / 非法值按 0 处理，不产生 NaN', () => {
    const result = aggregateWindow([
      { sales_amount: null, order_qty: undefined, pending_order_qty: 'abc' },
      {},
    ])
    expect(result).toEqual({ gmv: 0, orders: 0, pending: 0, adSpend: 0, adOrders: 0 })
  })

  it('Pending 取最新日期行的值（日期降序输入时仍取最新日）', () => {
    const result = aggregateWindow([
      { date: '2026-09-03', sales_amount: 100, order_qty: 1, pending_order_qty: 5 },
      { date: '2026-09-02', sales_amount: 100, order_qty: 1, pending_order_qty: 3 },
      { date: '2026-09-01', sales_amount: 100, order_qty: 1, pending_order_qty: 2 },
    ])
    expect(result.pending).toBe(5)
  })

  it('Pending 仅最新日期行：某行无 pending 值时不覆盖', () => {
    const result = aggregateWindow([
      { date: '2026-09-02', sales_amount: 100, order_qty: 1 },
      { date: '2026-09-01', sales_amount: 100, order_qty: 1, pending_order_qty: 2 },
    ])
    expect(result.pending).toBe(2)
  })

  it('广告字段求和（ad_spend / ad_orders），含字符串与非法值', () => {
    const result = aggregateWindow([
      { ad_spend: 80, ad_orders: 5 },
      { ad_spend: '20.5', ad_orders: '2' },
      { ad_spend: null, ad_orders: 'abc' },
      {},
    ])
    expect(result.adSpend).toBeCloseTo(100.5)
    expect(result.adOrders).toBe(7)
  })
})

describe('pickLatestSalesDate（BLF-921 Stage 2 原逻辑，7 天快报复用）', () => {
  it('从 available_dates.sales_report 取最新销售数据日期', () => {
    expect(
      pickLatestSalesDate({ sales_report: ['2026-08-30'], inventory_report: ['2026-08-29'] })
    ).toBe('2026-08-30')
  })

  it('缺 sales_report / 空数组 / null → null（频道降级隐藏）', () => {
    expect(pickLatestSalesDate({ inventory_report: ['2026-08-29'] })).toBeNull()
    expect(pickLatestSalesDate({ sales_report: [] })).toBeNull()
    expect(pickLatestSalesDate(undefined)).toBeNull()
  })
})

describe('pctChange 复用 Dashboard 首页函数（v2-stats）', () => {
  it('上涨：当前 1200 vs 基期 1000 → +20%', () => {
    expect(pctChange(1200, 1000)).toBeCloseTo(20)
  })

  it('下跌：当前 800 vs 基期 1000 → -20%', () => {
    expect(pctChange(800, 1000)).toBeCloseTo(-20)
  })

  it('基数为 0 时返回 0（与 Dashboard 首页 computeStats 一致）', () => {
    expect(pctChange(1200, 0)).toBe(0)
  })
})