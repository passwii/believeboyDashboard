import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { SalesTrendPanel, type SalesTrendRow } from './index'

const rows: SalesTrendRow[] = [
  { date: '2026-10-25', label: 'Sun', current: 1200, previous: 900 },
  { date: '2026-10-26', label: 'Mon', current: 1600, previous: 1400 },
  { date: '2026-10-27', label: 'Tue', current: 1100, previous: 1800 },
]

describe('SalesTrendPanel', () => {
  it('renders the PT window, both week legends, axes, and latest focus label', () => {
    const { container } = render(<SalesTrendPanel rows={rows} />)

    expect(screen.getByRole('heading', { name: '销售趋势' })).toBeInTheDocument()
    expect(screen.getByText('近 7 天 · PT 运营日')).toBeInTheDocument()
    expect(screen.getByText('本周')).toBeInTheDocument()
    expect(screen.getByText('上周')).toBeInTheDocument()
    const latestFocus = screen.getByTitle('2026-10-27 · 本周 $1,100.00')
    expect(latestFocus).toHaveTextContent('最新 · Tue · 本周 $1.1K')
    const chart = screen.getByRole('img', { name: '销售趋势图' })
    expect(chart.nextElementSibling).toHaveTextContent('SunMonTue')
    expect(chart).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('group', { name: '图例' })).toHaveClass('flex-wrap')
    expect(container.firstElementChild).toHaveClass('min-w-0', 'max-w-full')
    expect(chart).toHaveClass('w-full', 'min-w-0')
    expect(container.querySelector('[data-point="current"][r="4"]')).toBeInTheDocument()
    expect(container.querySelector('[data-series="current"]')).toHaveAttribute(
      'stroke',
      'var(--warm-ledger-color-accent)'
    )
    expect(container.querySelector('[data-series="previous"]')).toHaveAttribute(
      'stroke-dasharray',
      '5 5'
    )
  })

  it('shows a domain-specific empty status when no rows are available', () => {
    render(<SalesTrendPanel rows={[]} />)

    expect(screen.getByRole('status')).toHaveTextContent('暂无销售数据')
    expect(screen.queryByRole('img', { name: '销售趋势图' })).not.toBeInTheDocument()
  })

  it('shows a static loading status without rendering stale rows', () => {
    const { container } = render(<SalesTrendPanel rows={rows} loading />)

    expect(screen.getByRole('status')).toHaveTextContent('正在加载销售趋势')
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true')
    expect(screen.queryByText(/最新/)).not.toBeInTheDocument()
    expect(container.querySelector('[data-series="current"]')).toBeNull()
  })

  it('announces a supplied error and omits the chart', () => {
    render(<SalesTrendPanel rows={rows} error="销售趋势暂时无法加载" />)

    expect(screen.getByRole('alert')).toHaveTextContent('销售趋势暂时无法加载')
    expect(screen.queryByRole('img', { name: '销售趋势图' })).not.toBeInTheDocument()
  })

  it('keeps the comparison legend but omits a previous-week path when values are missing', () => {
    const currentOnly: SalesTrendRow[] = rows.map((row) => ({
      date: row.date,
      label: row.label,
      current: row.current,
    }))
    render(<SalesTrendPanel rows={currentOnly} />)

    expect(screen.getByText('上周')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: '销售趋势图' })).toBeInTheDocument()
    expect(document.querySelector('[data-series="previous"]')).toBeNull()
    expect(screen.getByText(/上周无数据/)).toBeInTheDocument()
  })

  it('renders a visible point for a single current-week observation', () => {
    const { container } = render(<SalesTrendPanel rows={[rows[0]]} />)

    const currentLine = container.querySelector('[data-series="current"]')
    expect(currentLine).toHaveAttribute('d', expect.stringMatching(/^M/))
    expect(container.querySelectorAll('[data-point="current"]')).toHaveLength(1)
  })

  it('keeps curve coordinates finite for extreme values', () => {
    const extremeRows: SalesTrendRow[] = [
      { date: '2026-10-25', label: 'Sun', current: 0, previous: Number.MIN_VALUE },
      { date: '2026-10-26', label: 'Mon', current: Number.MAX_SAFE_INTEGER, previous: 3 },
    ]
    const { container } = render(<SalesTrendPanel rows={extremeRows} />)
    const chart = screen.getByRole('img', { name: '销售趋势图' })
    const geometry = [
      ...Array.from(chart.querySelectorAll('path'), (path) => path.getAttribute('d') ?? ''),
      ...Array.from(chart.querySelectorAll('circle'), (circle) => circle.getAttribute('cy') ?? ''),
    ]

    expect(geometry.length).toBeGreaterThan(0)
    expect(geometry.join(' ')).not.toMatch(/NaN|Infinity/)
    expect(container.textContent).toContain('Mon')
  })

  it('provides a readable day-by-day summary through the image description', () => {
    render(<SalesTrendPanel rows={rows} />)

    const chart = screen.getByRole('img', { name: '销售趋势图' })
    const summaryId = chart.getAttribute('aria-describedby')
    const summary = summaryId ? document.getElementById(summaryId) : null

    expect(summary).toBeInTheDocument()
    expect(summary).toHaveTextContent('Sun')
    expect(summary).toHaveTextContent('Mon')
    expect(summary).toHaveTextContent('Tue')
    expect(summary).toHaveTextContent('本周')
    expect(summary).toHaveTextContent('上周')
    expect(summary).toHaveTextContent('$1,200.00')
    expect(summary).toHaveTextContent('$1,800.00')
  })
})
