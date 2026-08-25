import { describe, expect, it } from 'vitest'

import { reduceDailyBrief } from './use-daily-brief'

describe('reduceDailyBrief', () => {
  it('把 summary_rows 求和为全局 GMV / 订单 / Pending', () => {
    const brief = reduceDailyBrief([
      { sales_amount: 1200.5, order_qty: 10, pending_order_qty: 2 },
      { sales_amount: '800', order_qty: '5', pending_order_qty: '3' },
    ])
    expect(brief).toEqual({ gmv: 2000.5, orders: 15, pending: 5 })
  })

  it('空行 / 非法值按 0 处理，不产生 NaN', () => {
    const brief = reduceDailyBrief([
      { sales_amount: null, order_qty: undefined, pending_order_qty: 'abc' },
      {},
    ])
    expect(brief).toEqual({ gmv: 0, orders: 0, pending: 0 })
  })
})
