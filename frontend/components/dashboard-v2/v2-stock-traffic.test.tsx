import { describe, expect, it } from 'vitest'

import { computeStockTrend } from './v2-stock-chart'
import { computeTrafficStats } from './v2-traffic-chart'

describe('computeStockTrend', () => {
  const current = [
    { date: '2026-07-29', available_qty: 300 },
    { date: '2026-07-30', available_qty: 280 },
    { date: '2026-07-31', available_qty: 260 },
  ]
  const comparison = [
    { date: '2026-07-22', available_qty: 200 },
    { date: '2026-07-23', available_qty: 250 },
  ]

  it('末值 = 260，环比 = +4%（260 vs 上期末 250）', () => {
    const trend = computeStockTrend(current, comparison)
    expect(trend.current).toBe(260)
    expect(trend.prev).toBe(250)
    expect(trend.delta).toBeCloseTo(4, 5)
    expect(trend.rows).toHaveLength(3)
    expect(trend.rows[2]).toEqual({ day: '7/31', qty: 260 })
  })

  it('上一周期为空时 delta 为 0', () => {
    const trend = computeStockTrend(current)
    expect(trend.delta).toBe(0)
  })

  it('空数据时 current 为 0', () => {
    const trend = computeStockTrend([])
    expect(trend.current).toBe(0)
    expect(trend.rows).toEqual([])
  })
})

describe('computeTrafficStats', () => {
  const rows = [
    { date: '2026-07-30', page_views: 800, units_ordered: 40, sessions: 600 },
    { date: '2026-07-31', page_views: 1200, units_ordered: 80, sessions: 900 },
  ]

  it('汇总浏览量/访客数/转化订单，转化率 = 120/2000×100 = 6%', () => {
    const stats = computeTrafficStats(rows)
    expect(stats.totalPageViews).toBe(2000)
    expect(stats.totalSessions).toBe(1500)
    expect(stats.totalUnitsOrdered).toBe(120)
    expect(stats.conversionRatePct).toBeCloseTo(6, 5)
  })

  it('无浏览量时转化率为 0', () => {
    const stats = computeTrafficStats([{ date: 'd', page_views: 0, units_ordered: 5, sessions: 0 }])
    expect(stats.conversionRatePct).toBe(0)
  })
})
