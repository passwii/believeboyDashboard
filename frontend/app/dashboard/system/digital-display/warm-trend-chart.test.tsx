import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import {
  WarmChartTooltip,
  WarmTrendChart,
  type WarmChartTooltipEntry,
} from './warm-trend-chart'

const data = [
  { date: '2026-11-01', sales_amount: 1200, order_qty: 12 },
  { date: '2026-11-02', sales_amount: 1800, order_qty: 18 },
]

const config = {
  sales_amount: { label: '销售额', color: 'var(--warm-ledger-color-accent)' },
  order_qty: { label: '订单量', color: 'var(--warm-ledger-color-text-soft)' },
}

describe('Digital Display Warm Trend Chart', () => {
  it('renders a page-local Warm chart without Terminal chart defaults', () => {
    const { container } = render(
      <WarmTrendChart
        data={data}
        xKey="date"
        config={config}
        series={[
          { dataKey: 'sales_amount', name: '销售额' },
          { dataKey: 'order_qty', name: '订单量' },
        ]}
        yTickFormatter={(value) => `¥${Math.round(value)}`}
      />
    )

    expect(screen.getByTestId('digital-display-warm-chart')).toHaveAttribute(
      'data-warm-chart',
      'true'
    )
    expect(screen.getByTestId('digital-display-warm-chart-legend')).toHaveTextContent('销售额')
    expect(screen.getByTestId('digital-display-warm-chart-legend')).toHaveTextContent('订单量')
    expect(container.querySelector('[class*="term-"]')).toBeNull()
    expect(container.querySelector('.recharts-default-tooltip')).toBeNull()
  })

  it('uses the supplied formatter in the Warm tooltip', () => {
    const payload: WarmChartTooltipEntry[] = [
      {
        name: '销售额',
        value: 1800,
        color: 'var(--warm-ledger-color-accent)',
      },
    ]

    render(
      <WarmChartTooltip
        active
        label="2026-11-02"
        payload={payload}
        dataKeyMap={{ 销售额: 'sales_amount' }}
        formatter={(value, name) => (name === 'sales_amount' ? `$${value}` : String(value))}
      />
    )

    expect(screen.getByTestId('digital-display-warm-chart-tooltip')).toHaveTextContent(
      '2026-11-02'
    )
    expect(screen.getByTestId('digital-display-warm-chart-tooltip')).toHaveTextContent('$1800')
    expect(screen.getByTestId('digital-display-warm-chart-tooltip')).toHaveTextContent('销售额')
  })
})
