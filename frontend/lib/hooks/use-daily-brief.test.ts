import { describe, expect, it } from 'vitest'

import { computeChangePct, pickLatestSalesDate, reduceDailyBrief } from './use-daily-brief'

// 上周同日基线 fixture：gmv 1100 / orders 9（供 WoW 计算；DoD 用例中不参与比较）
const lastWeekBase = { gmv: 1100, orders: 9, pending: 0, adSpend: 0, adOrders: 0 }

describe('reduceDailyBrief', () => {
  it('把 summary_rows 求和为全局 GMV / 订单 / Pending / 广告字段', () => {
    const brief = reduceDailyBrief([
      { sales_amount: 1200.5, order_qty: 10, pending_order_qty: 2, ad_spend: 40, ad_orders: 3 },
      { sales_amount: '800', order_qty: '5', pending_order_qty: '3', ad_spend: '60', ad_orders: 2 },
    ])
    expect(brief).toEqual({ gmv: 2000.5, orders: 15, pending: 5, adSpend: 100, adOrders: 5 })
  })

  it('空行 / 非法值按 0 处理，不产生 NaN', () => {
    const brief = reduceDailyBrief([
      { sales_amount: null, order_qty: undefined, pending_order_qty: 'abc' },
      {},
    ])
    expect(brief).toEqual({ gmv: 0, orders: 0, pending: 0, adSpend: 0, adOrders: 0 })
  })
})

describe('reduceDailyBrief 广告字段求和（BLF-920 Stage 1）', () => {
  it('归约 ad_spend / ad_orders，含字符串与非法值', () => {
    const brief = reduceDailyBrief([
      { ad_spend: 80, ad_orders: 5 },
      { ad_spend: '20.5', ad_orders: '2' },
      { ad_spend: null, ad_orders: 'abc' },
      {},
    ])
    expect(brief.adSpend).toBe(100.5)
    expect(brief.adOrders).toBe(7)
  })
})

describe('pickLatestSalesDate（BLF-921 Stage 2）', () => {
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

describe('computeChangePct 环比（BLF-920 Stage 1）', () => {
  it('今天 1200 vs 昨天 1000 → +20%；订单 10 vs 8 → +25%', () => {
    const today = reduceDailyBrief([{ sales_amount: 1200, order_qty: 10 }])
    const yesterday = reduceDailyBrief([{ sales_amount: 1000, order_qty: 8 }])
    const brief = computeChangePct(today, yesterday, lastWeekBase)
    expect(brief.gmvDoD).toBeCloseTo(20)
    expect(brief.ordersDoD).toBeCloseTo(25)
    expect(brief.gmvWoW).toBeCloseTo(9.09)
    expect(brief.ordersWoW).toBeCloseTo(11.11)
  })

  it('基数为 0 时环比为 null（除零防护）', () => {
    const today = reduceDailyBrief([{ sales_amount: 1200, order_qty: 10 }])
    const yesterday = reduceDailyBrief([{ sales_amount: 0, order_qty: 0 }])
    const brief = computeChangePct(today, yesterday, yesterday)
    expect(brief.gmvDoD).toBeNull()
    expect(brief.ordersDoD).toBeNull()
    expect(brief.gmvWoW).toBeNull()
    expect(brief.ordersWoW).toBeNull()
  })

  it('下跌为负百分比：今天 800 vs 昨天 1000 → -20%', () => {
    const today = reduceDailyBrief([{ sales_amount: 800, order_qty: 4 }])
    const yesterday = reduceDailyBrief([{ sales_amount: 1000, order_qty: 5 }])
    const brief = computeChangePct(today, yesterday, yesterday)
    expect(brief.gmvDoD).toBeCloseTo(-20)
    expect(brief.ordersDoD).toBeCloseTo(-20)
  })
})
