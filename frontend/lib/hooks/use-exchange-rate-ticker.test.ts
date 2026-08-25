import { describe, expect, it } from 'vitest'

import { reduceLatestTicks } from './use-exchange-rate-ticker'

describe('reduceLatestTicks', () => {
  it('按 year_month 取每个币种最新一条', () => {
    const ticks = reduceLatestTicks([
      { currency: 'USD', rate: 7.12, year_month: '2026-06' },
      { currency: 'USD', rate: 7.16, year_month: '2026-08' },
      { currency: 'USD', rate: 7.14, year_month: '2026-07' },
      { currency: 'EUR', rate: 7.84, year_month: '2026-08' },
    ])
    expect(ticks.find((t) => t.currency === 'USD')?.rate).toBe(7.16)
    expect(ticks.find((t) => t.currency === 'EUR')?.rate).toBe(7.84)
  })

  it('接口返回的全部币种都保留（按字母序），不再写死白名单', () => {
    const ticks = reduceLatestTicks([
      { currency: 'JPY', rate: 0.048, year_month: '2026-08' },
      { currency: 'GBP', rate: 9.05, year_month: '2026-05' },
    ])
    expect(ticks.map((t) => t.currency)).toEqual(['GBP', 'JPY'])
    expect(ticks.find((t) => t.currency === 'JPY')?.rate).toBe(0.048)
  })

  it('year_month 缺失时不影响归约（空串比较兜底）', () => {
    const ticks = reduceLatestTicks([{ currency: 'USD', rate: 7.1, year_month: null }])
    expect(ticks.find((t) => t.currency === 'USD')?.rate).toBe(7.1)
  })

  it('环比：最新相对上一月计算涨跌百分比；同月重复记录不算涨跌', () => {
    const ticks = reduceLatestTicks([
      { currency: 'USD', rate: 7.0, year_month: '2026-07' },
      { currency: 'USD', rate: 7.14, year_month: '2026-08' },
      // 同月的旧上传应被忽略，不参与环比
      { currency: 'USD', rate: 7.2, year_month: '2026-08' },
      { currency: 'EUR', rate: 7.84, year_month: '2026-08' },
    ])
    const usd = ticks.find((t) => t.currency === 'USD')
    expect(usd?.rate).toBe(7.14)
    expect(usd?.changePct).toBeCloseTo(((7.14 - 7.0) / 7.0) * 100, 6)
    // 只有一条记录 → 无环比
    expect(ticks.find((t) => t.currency === 'EUR')?.changePct).toBeNull()
  })
})
