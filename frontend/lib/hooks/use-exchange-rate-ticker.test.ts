import { describe, expect, it } from 'vitest'

import { reduceLatestTicks } from './use-exchange-rate-ticker'

describe('reduceLatestTicks', () => {
  it('按 year_month 取每个目标币种最新一条', () => {
    const ticks = reduceLatestTicks([
      { currency: 'USD', rate: 7.12, year_month: '2026-06' },
      { currency: 'USD', rate: 7.16, year_month: '2026-08' },
      { currency: 'USD', rate: 7.14, year_month: '2026-07' },
      { currency: 'EUR', rate: 7.84, year_month: '2026-08' },
    ])
    expect(ticks.find((t) => t.currency === 'USD')?.rate).toBe(7.16)
    expect(ticks.find((t) => t.currency === 'EUR')?.rate).toBe(7.84)
  })

  it('目标外的币种被过滤；缺失币种降级为 null 占位', () => {
    const ticks = reduceLatestTicks([
      { currency: 'JPY', rate: 0.048, year_month: '2026-08' },
      { currency: 'GBP', rate: 9.05, year_month: '2026-05' },
    ])
    expect(ticks.map((t) => t.currency)).toEqual(['USD', 'EUR', 'GBP'])
    expect(ticks.find((t) => t.currency === 'USD')).toMatchObject({ rate: null, yearMonth: null })
    expect(ticks.find((t) => t.currency === 'GBP')?.rate).toBe(9.05)
  })

  it('year_month 缺失时不影响归约（空串比较兜底）', () => {
    const ticks = reduceLatestTicks([{ currency: 'USD', rate: 7.1, year_month: null }])
    expect(ticks.find((t) => t.currency === 'USD')?.rate).toBe(7.1)
  })
})
