import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { computeStats, V2Stats, type V2StatRow } from './v2-stats'

const current: V2StatRow[] = [
  { date: '2026-07-30', order_qty: 10, sales_amount: 100, ad_spend: 20, page_views: 1000, units_ordered: 50 },
  { date: '2026-07-31', order_qty: 30, sales_amount: 300, ad_spend: 40, page_views: 1000, units_ordered: 50 },
]
// 上一周期：销售额 320、订单 50、广告 60、转化率 4%
const comparison: V2StatRow[] = [
  { date: '2026-07-28', order_qty: 20, sales_amount: 120, ad_spend: 30, page_views: 1000, units_ordered: 40 },
  { date: '2026-07-29', order_qty: 30, sales_amount: 200, ad_spend: 30, page_views: 1000, units_ordered: 40 },
]

describe('computeStats', () => {
  it('销售额 = 400，环比 +25%', () => {
    const stats = computeStats(current, comparison)
    expect(stats[0].label).toBe('销售额')
    expect(stats[0].value).toBe('$400')
    expect(stats[0].delta).toBeCloseTo(25, 5)
  })

  it('订单量 = 40，环比 -20%', () => {
    const stats = computeStats(current, comparison)
    expect(stats[1].label).toBe('订单量')
    expect(stats[1].delta).toBeCloseTo(-20, 5)
  })

  it('广告花费 = 60，环比 0%', () => {
    const stats = computeStats(current, comparison)
    expect(stats[2].label).toBe('广告花费')
    expect(stats[2].delta).toBe(0)
  })

  it('转化率 = 5.00%（units_ordered/page_views），环比 +25%', () => {
    const stats = computeStats(current, comparison)
    expect(stats[3].label).toBe('转化率')
    expect(stats[3].value).toBe('5.00%')
    expect(stats[3].delta).toBeCloseTo(25, 5)
  })

  it('上一周期为空时 delta 为 0', () => {
    const stats = computeStats(current, [])
    expect(stats.every((s) => s.delta === 0)).toBe(true)
  })
})

describe('V2Stats', () => {
  it('loading 时渲染 4 个骨架卡', () => {
    const { container } = render(<V2Stats currentRows={[]} loading />)
    // 项目 Skeleton 用自定义 u-skeleton-shimmer 类（非默认 animate-pulse）
    expect(container.querySelectorAll('.u-skeleton-shimmer').length).toBeGreaterThanOrEqual(4)
  })

  it('渲染 4 个 KPI 标签', () => {
    render(<V2Stats currentRows={current} comparisonRows={comparison} />)
    expect(screen.getByText('销售额')).toBeInTheDocument()
    expect(screen.getByText('订单量')).toBeInTheDocument()
    expect(screen.getByText('广告花费')).toBeInTheDocument()
    expect(screen.getByText('转化率')).toBeInTheDocument()
  })

  it('BLF-909 终端化：KPI 标签走 mono + uppercase + term-faint', () => {
    const { container } = render(<V2Stats currentRows={current} comparisonRows={comparison} />)
    // 4 个 KPI 标签都应用 mono + uppercase + term-faint（终端化视觉锚点）
    const labels = container.querySelectorAll('[data-slot="delta"]')
    expect(labels.length).toBeGreaterThanOrEqual(4)
    // 标题走 CardTitle → text-term-faint + font-mono + uppercase tracking-wider
    const titles = container.querySelectorAll('[class*="text-term-faint"][class*="font-mono"][class*="uppercase"]')
    expect(titles.length).toBeGreaterThanOrEqual(4)
  })

})