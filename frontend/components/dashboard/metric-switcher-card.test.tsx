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
    expect(header?.className).toContain('pb-3')
  })

  it('指标卡片正常渲染', () => {
    const { container } = renderCard()
    expect(container.textContent).toContain('指标A')
    expect(container.textContent).toContain('指标B')
  })
})

// BLF-908：bar chart 顶部 stats 区域终端化——label / 数值 / hint / 对比 pill
// 全部切到 term 语义色 + mono 字体（与 TermKpiTile 同规格），不再使用 Badge
// 彩色胶囊底。回归测试锁契约：mono + term-* 颜色 + 零圆角 pill。
describe('metric-switcher-card · stats 终端化（BLF-908）', () => {
  it('指标选择态使用 term 表面和无圆角 accent 指示条', () => {
    const { container } = renderCard()
    const metricGrid = container.querySelector('.grid')!
    const activeButton = metricGrid.querySelector('button[aria-pressed="true"]')!
    const inactiveButton = metricGrid.querySelector('button[aria-pressed="false"]')!
    const indicator = activeButton.querySelector('span.absolute')

    expect(activeButton.className).toContain('bg-term-raised')
    expect(activeButton.className).not.toContain('bg-primary')
    expect(inactiveButton.className).toContain('hover:bg-term-hover')
    expect(indicator?.className).toContain('rounded-none')
    expect(indicator?.className).toContain('bg-term-accent')
    expect(indicator?.className).not.toContain('rounded-full')
  })

  it('图表形态切换使用终端尺寸、边界和 pressed 状态', () => {
    const { container } = renderCard()
    const lineButton = screen.getByRole('button', { name: /折线/ })
    const toggle = lineButton.parentElement as HTMLElement

    expect(toggle.className).toContain('rounded-none')
    expect(toggle.className).toContain('border-term-border')
    expect(toggle.className).toContain('bg-term-panel')
    expect(toggle.className).toContain('h-9')
    expect(toggle.className).not.toContain('rounded-full')
    expect(toggle.className).not.toContain('shadow-')
    expect(lineButton).toHaveAttribute('aria-pressed', 'true')
    expect(within(toggle).getByRole('button', { name: /面积/ })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('group', { name: '图表形态' })).toBe(toggle)
    expect(container.querySelector('[data-testid="chart-kind-toggle"]')).toBe(toggle)
  })

  it('label / 数值 / hint 使用 mono 字体 + term 语义色', () => {
    const { container } = renderCard()
    // label：mono + uppercase + tracking-wider + term-muted
    const label = container.querySelector('span.uppercase')
    expect(label?.className).toContain('font-mono')
    expect(label?.className).toContain('text-term-muted')
    // 数值：mono + tabular-nums + leading-6
    const value = container.querySelector('div.leading-6')
    expect(value?.className).toContain('font-mono')
    expect(value?.className).toContain('tabular-nums')
    expect(value?.className).toMatch(/text-term-(muted|text)/)
  })

  it('对比 pill 改用 term 终端规格（mono + 零圆角 + 1px current 边）', () => {
    const { container } = renderCard()
    // 不再使用 Badge 彩色胶囊底（无 bg-secondary / bg-destructive 等）
    expect(container.innerHTML).not.toMatch(/bg-secondary\//)
    expect(container.innerHTML).not.toMatch(/bg-destructive\//)
    // pill 元素带 rounded-none + border-current/30 + font-mono
    const pill = container.querySelector('span[class*="border-current/30"]')
    expect(pill?.className).toContain('rounded-none')
    expect(pill?.className).toContain('font-mono')
  })
})
