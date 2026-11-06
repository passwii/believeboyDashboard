import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'

import { MetricSwitcherCard, type MetricDef } from './metric-switcher-card'

// BLF-529 回归测试：指标卡片区域必须左右无内边距（占满卡片两侧）、顶部无内边距（顶对齐）。
// 背景：旧 CardHeader 基类自带 `md:px-7 md:pb-3 md:pt-7`，需要 `p-0 + md:px-0 + md:pt-0` 组合覆盖。
// BLF-872 Terminal 收口后 CardHeader 基类收敛为无 md 断点的 `px-4 pb-3 pt-4`，
// `p-0` 即可完全清零；底部 pb-3 显式保留给"形态"切换行。
const metrics: MetricDef<'a' | 'b'>[] = [
  { key: 'a', label: '指标A', format: (v) => String(v) },
  { key: 'b', label: '指标B', format: (v) => String(v) },
]

function renderCard() {
  const { container } = render(
    <MetricSwitcherCard
      metrics={metrics}
      chartKind="auto"
      showChartKindToggle
      renderLine={() => [{ date: '2026-01-01', a: 1, b: 2 }]}
    />
  )
  // 指标卡片网格 = `grid grid-cols-2 ...`；其父元素即 CardHeader。
  const grid = container.querySelector('[class*="grid-cols-2"]')
  if (!grid) throw new Error('未找到指标卡片网格')
  return { container, grid, header: grid.parentElement }
}

describe('metric-switcher-card · 指标卡片区内边距（BLF-529）', () => {
  it('CardHeader 带 p-0 清零内边距，无 px-6 / md:px-7 / md:pt-7 残留', () => {
    const { header } = renderCard()
    expect(header?.className).toContain('p-0')
    expect(header?.className).not.toContain('md:px-7')
    expect(header?.className).not.toContain('md:pt-7')
    expect(header?.className).not.toContain('px-6')
    expect(header?.className).not.toContain('px-4')
    // 底部内边距保留（"形态"切换行的呼吸空间）
    expect(header?.className).toContain('pb-2')
  })

  it('指标卡片正常渲染', () => {
    const { container } = renderCard()
    expect(container.textContent).toContain('指标A')
    expect(container.textContent).toContain('指标B')
  })
})

// V4 Warm Ledger：指标区使用暖色中性表面、sans label、mono 数值和轻量 pill。
describe('metric-switcher-card · Warm Ledger stats', () => {
  it('指标选择态使用 V4 抬升表面和 accent 指示条', () => {
    const { container } = renderCard()
    const metricGrid = container.querySelector('.grid')!
    const activeButton = metricGrid.querySelector('button[aria-pressed="true"]')!
    const inactiveButton = metricGrid.querySelector('button[aria-pressed="false"]')!
    const indicator = activeButton.querySelector('span.absolute')

    expect(activeButton.className).toContain('min-h-[88px]')
    expect(activeButton.className).toContain('bg-[var(--warm-ledger-color-raised)]')
    expect(activeButton.className).not.toContain('bg-primary')
    expect(inactiveButton.className).toContain(
      'hover:bg-[var(--warm-ledger-color-raised-hover)]'
    )
    expect(indicator?.className).toContain('rounded-none')
    expect(indicator?.className).toContain('bg-[var(--warm-ledger-color-accent)]')
    expect(indicator?.className).not.toContain('rounded-full')
  })

  it('图表形态切换使用暖色中性边界、pressed 状态和非 amber 填充', () => {
    const { container } = renderCard()
    const lineButton = screen.getByRole('button', { name: /折线/ })
    const toggle = lineButton.parentElement as HTMLElement

    expect(toggle.className).toContain('rounded-[var(--warm-ledger-radius-inner)]')
    expect(toggle.className).toContain('border-[var(--warm-ledger-color-hairline)]')
    expect(toggle.className).toContain('bg-[var(--warm-ledger-color-panel)]')
    expect(toggle.className).toContain('h-9')
    expect(toggle.className).not.toContain('rounded-full')
    expect(lineButton).toHaveAttribute('aria-pressed', 'true')
    expect(lineButton.className).not.toContain('bg-term-accent')
    expect(lineButton.className).not.toContain('text-term-panel')
    expect(within(toggle).getByRole('button', { name: /面积/ })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('group', { name: '图表形态' })).toBe(toggle)
    expect(container.querySelector('[data-testid="chart-kind-toggle"]')).toBe(toggle)

    const activeSpans = Array.from(lineButton.querySelectorAll('span.absolute'))
    expect(
      activeSpans.some((span) =>
        span.className.includes('bg-[var(--warm-ledger-color-raised)]')
      )
    ).toBe(true)
    expect(
      activeSpans.some((span) =>
        span.className.includes('bg-[var(--warm-ledger-color-accent)]')
      )
    ).toBe(true)
  })

  it('label 使用 sans + muted，数值使用 mono + tabular', () => {
    const { container } = renderCard()
    const label = screen.getByText('指标A')
    expect(label.className).toContain('font-sans')
    expect(label.className).toContain('text-[var(--warm-ledger-color-text-muted)]')
    const value = container.querySelector('div.leading-6')
    expect(value?.className).toContain('font-mono')
    expect(value?.className).toContain('tabular-nums')
    expect(value?.className).toContain('text-[var(--warm-ledger-color-text)]')
  })

  it('对比 pill 使用 mono + 内层圆角 + 中性 hairline 边', () => {
    const { container } = renderCard()
    expect(container.innerHTML).not.toMatch(/bg-secondary\//)
    expect(container.innerHTML).not.toMatch(/bg-destructive\//)
    const pill = screen.getAllByText('--')[0]
    expect(pill.className).toContain('rounded-[var(--warm-ledger-radius-inner)]')
    expect(pill.className).toContain('border-[var(--warm-ledger-color-hairline)]')
    expect(pill.className).toContain('font-mono')
  })

  it('keeps comparison values in metric cells without a summary row', () => {
    render(
      <MetricSwitcherCard
        metrics={metrics}
        defaultMetric="a"
        chartKind="auto"
        getCurrent={() => 10}
        getPrevious={() => 5}
        renderLine={() => [{ date: '2026-01-01', a: 1, b: 2 }]}
      />
    )

    expect(screen.queryByText('本期合计')).not.toBeInTheDocument()
    expect(screen.getAllByText(/^对比 5$/)).toHaveLength(metrics.length)
  })
})
