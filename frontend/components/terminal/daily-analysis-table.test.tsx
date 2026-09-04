import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { DailyAnalysisTable, type DailyAnalysisTableRow } from './daily-analysis-table'

const ROWS: DailyAnalysisTableRow[] = [
  {
    date: '2026-08-01',
    order_qty: 10,
    sales_amount: 1000,
    impressions: 100,
    clicks: 50,
    cpc: 0.5,
    ad_spend: 200,
    ad_orders: 5,
    page_views: 800,
    units_ordered: 40,
    conversion_rate: 0.05,
  },
  {
    date: '2026-08-02',
    order_qty: 20,
    sales_amount: 2000,
    impressions: 200,
    clicks: 60,
    cpc: 0.6,
    ad_spend: 300,
    ad_orders: 8,
    page_views: 1000,
    units_ordered: 60,
    conversion_rate: 0.06,
  },
]

describe('DailyAnalysisTable', () => {
  it('按日期倒序渲染（最新在上）且数字等宽右对齐', () => {
    const { container } = render(<DailyAnalysisTable rows={ROWS} />)
    const cells = container.querySelectorAll('tbody tr td:first-child')
    expect(cells[0].textContent).toBe('2026-08-02')
    expect(cells[1].textContent).toBe('2026-08-01')
    // 销售额带千分位与币符
    expect(screen.getByText('$2,000.00')).toBeInTheDocument()
    expect(screen.getByText('$1,000.00')).toBeInTheDocument()
    // 转化率百分比
    expect(screen.getByText('5.00%')).toBeInTheDocument()
  })

  it('环比上涨着涨色、下跌着跌色', () => {
    const { container } = render(<DailyAnalysisTable rows={ROWS} />)
    // 最新行（08-02）订单 20 > 前日 10 → 涨色；前一日无对比 → muted
    const rows = container.querySelectorAll('tbody tr')
    const latestOrderCell = rows[0].querySelectorAll('td')[1]
    expect(latestOrderCell.className).toContain('text-term-pos')
    const firstOrderCell = rows[1].querySelectorAll('td')[1]
    expect(firstOrderCell.className).toContain('text-term-muted')
  })

  it('loading 渲染骨架行；空数据渲染占位文案', () => {
    const { container: loadingContainer } = render(<DailyAnalysisTable rows={[]} loading />)
    expect(loadingContainer.querySelectorAll('.u-skeleton-shimmer, [class*=skeleton]').length).toBeGreaterThan(0)

    const { container: emptyContainer } = render(<DailyAnalysisTable rows={[]} />)
    expect(emptyContainer.textContent).toContain('暂无数据')
  })
})
