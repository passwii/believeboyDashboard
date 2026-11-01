import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import {
  DiagnosticStrip,
  MetricCard,
  MetricStrip,
  type DiagnosticItemData,
  type MetricItem,
} from './index'

const metrics: MetricItem[] = [
  {
    key: 'sales',
    label: '销售额',
    value: '$122,460',
    code: 'USD',
    comparison: { delta: 11.5, label: 'vs 上周', reference: '$109,800' },
    tone: 'accent',
    meta: '19 个项目',
  },
  {
    key: 'orders',
    label: '订单量',
    value: 0,
    comparison: { delta: -3.2, label: 'vs 上周' },
  },
]

describe('MetricStrip and MetricCard', () => {
  it('renders supplied values and metadata, including a real zero, with the first card featured', () => {
    render(<MetricStrip items={metrics} state="ready" ariaLabel="本周关键指标" />)

    const strip = screen.getByRole('region', { name: '本周关键指标' })
    const cards = within(strip).getAllByRole('article')

    expect(cards).toHaveLength(2)
    expect(cards[0]).toHaveAttribute('data-featured', 'true')
    expect(cards[1]).toHaveAttribute('data-featured', 'false')
    expect(within(cards[0]).getByText('销售额')).toBeInTheDocument()
    expect(within(cards[0]).getByText('USD')).toBeInTheDocument()
    expect(within(cards[0]).getByText('$122,460')).toBeInTheDocument()
    expect(within(cards[0]).getByText('19 个项目')).toBeInTheDocument()
    expect(within(cards[1]).getByText('0')).toBeInTheDocument()
  })

  it('uses static skeletons while loading and does not expose stale values', () => {
    const { container } = render(<MetricStrip items={metrics} state="loading" />)

    expect(screen.getByRole('region')).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(container.querySelectorAll('[data-testid="metric-skeleton"]')).toHaveLength(2)
    expect(screen.queryByText('$122,460')).not.toBeInTheDocument()
    expect(screen.queryByText('0')).not.toBeInTheDocument()
  })

  it('keeps the three key metric slots when loading begins before item data arrives', () => {
    const { container } = render(<MetricStrip items={[]} state="loading" />)

    expect(container.querySelectorAll('[data-testid="metric-skeleton"]')).toHaveLength(3)
  })

  it('shows em dashes for every value in the explicit empty state', () => {
    render(<MetricStrip items={metrics} state="empty" />)

    expect(screen.getAllByText('—')).toHaveLength(2)
    expect(screen.queryByText('$122,460')).not.toBeInTheDocument()
    expect(screen.queryByText('vs 上周')).not.toBeInTheDocument()
  })

  it('presents a negative delta with a downward arrow, minus sign, and comparison label', () => {
    render(<MetricCard item={metrics[1]} state="ready" />)

    const delta = screen.getByLabelText('下降 −3.2% vs 上周')
    expect(delta).toHaveAttribute('data-tone', 'negative')
    expect(within(delta).getByText('↓')).toHaveAttribute('aria-hidden', 'true')
    expect(within(delta).getByText('−3.2%')).toBeInTheDocument()
    expect(within(delta).getByText('vs 上周')).toBeInTheDocument()
  })

  it('keeps long values and labels available while constraining the value slot', () => {
    const longLabel = '跨境电商多品牌运营总览的超长指标标签用于验证窄屏换行'
    const longValue = '$123,456,789,012,345,678,901,234,567,890'
    render(
      <MetricCard
        item={{ key: 'long', label: longLabel, value: longValue }}
        state="ready"
      />
    )

    expect(screen.getByText(longLabel)).toHaveAttribute('title', longLabel)
    expect(screen.getByText(longValue)).toHaveAttribute('title', longValue)
    expect(screen.getByText(longValue)).toHaveStyle({
      minWidth: '0',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    })
  })

  it('renders passive cards without hover affordances or interactive controls', () => {
    const { container } = render(<MetricStrip items={metrics} state="ready" />)

    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    for (const card of container.querySelectorAll('[data-metric-card]')) {
      expect(card).not.toHaveAttribute('tabindex')
      expect(card.className).not.toMatch(/hover|cursor-pointer/)
    }
  })

  it('exposes an error state as an alert without rendering stale metric values', () => {
    render(
      <MetricStrip
        items={metrics}
        state="error"
        errorMessage="销售数据加载失败"
      />
    )

    expect(screen.getByRole('alert')).toHaveTextContent('销售数据加载失败')
    expect(screen.queryByText('$122,460')).not.toBeInTheDocument()
  })
})

const diagnostics: DiagnosticItemData[] = [
  {
    key: 'ad-spend',
    label: '广告效率',
    value: '$18,930',
    meta: 'ACoAS 15.5%',
    unit: 'USD',
    progress: -15,
  },
  {
    key: 'inventory',
    label: '库存水位',
    value: 8420,
    unit: '件',
    meta: '区间末快照',
    progress: 135,
  },
  {
    key: 'traffic',
    label: '流量与转化',
    value: '9.4%',
    meta: '浏览量 13,660',
    progress: 50,
  },
]

describe('DiagnosticStrip', () => {
  it('maps diagnostic items with text values, metadata, units, and clamped progress', () => {
    render(<DiagnosticStrip items={diagnostics} state="ready" />)

    expect(screen.getByText('$18,930')).toBeInTheDocument()
    expect(screen.getByText('ACoAS 15.5%')).toBeInTheDocument()
    expect(screen.getByText('USD')).toBeInTheDocument()
    expect(screen.getByText('8420')).toBeInTheDocument()
    expect(screen.getByText('件')).toBeInTheDocument()

    const progressBars = screen.getAllByRole('progressbar')
    expect(progressBars.map((bar) => bar.getAttribute('aria-value' + 'now'))).toEqual([
      '0',
      '100',
      '50',
    ])
    expect(progressBars[0]).toHaveAttribute('aria-valuemin', '0')
    expect(progressBars[0]).toHaveAttribute('aria-valuemax', '100')
  })

  it('uses em dashes for empty values instead of showing stale numbers or progress', () => {
    render(<DiagnosticStrip items={diagnostics} state="empty" />)

    expect(screen.getAllByText('—')).toHaveLength(3)
    expect(screen.queryByText('$18,930')).not.toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('shows explicit loading and error states', () => {
    const loading = render(<DiagnosticStrip items={diagnostics} state="loading" />)
    expect(loading.container.querySelectorAll('[data-testid="diagnostic-skeleton"]')).toHaveLength(3)
    expect(screen.getByRole('status')).toBeInTheDocument()

    loading.unmount()
    render(
      <DiagnosticStrip
        items={diagnostics}
        state="error"
        errorMessage="经营辅助指标加载失败"
      />
    )
    expect(screen.getByRole('alert')).toHaveTextContent('经营辅助指标加载失败')
  })

  it('keeps four diagnostic slots when loading begins before item data arrives', () => {
    const { container } = render(<DiagnosticStrip items={[]} state="loading" />)

    expect(container.querySelectorAll('[data-testid="diagnostic-skeleton"]')).toHaveLength(4)
  })

  it('renders as a passive strip without hover or interactive affordances', () => {
    const { container } = render(<DiagnosticStrip items={diagnostics} state="ready" />)

    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    for (const item of container.querySelectorAll('[data-diagnostic-item]')) {
      expect(item).not.toHaveAttribute('tabindex')
      expect(item.className).not.toMatch(/hover|cursor-pointer/)
    }
  })
})
