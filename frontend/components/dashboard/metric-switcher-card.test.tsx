import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'

import { MetricSwitcherCard, type MetricDef } from './metric-switcher-card'

// BLF-529 回归测试：指标卡片区域在 md+ 断点必须左右无内边距（占满卡片两侧）。
// 背景：CardHeader 基类自带 `md:px-7 md:pb-3 md:pt-7`，若只用 `p-0` 覆盖，
// tailwind-merge 只去掉无响应式的 `px-6/pt-6/pb-3`，md 变体原样保留 ——
// 桌面端指标卡片两侧会残留 1.75rem 空隙。修复补 `md:px-0` 抵消 md 变体。
const metrics: MetricDef<'a' | 'b'>[] = [
  { key: 'a', label: '指标A', format: (v) => String(v) },
  { key: 'b', label: '指标B', format: (v) => String(v) },
]

function renderCard() {
  const { container } = render(
    <MetricSwitcherCard
      metrics={metrics}
      renderLine={() => [{ date: '2026-01-01', a: 1, b: 2 }]}
    />
  )
  // 指标卡片网格 = `grid grid-cols-2 ...`；其父元素即 CardHeader。
  const grid = container.querySelector('[class*="grid-cols-2"]')
  if (!grid) throw new Error('未找到指标卡片网格')
  return { container, grid, header: grid.parentElement }
}

describe('metric-switcher-card · 指标卡片区左右内边距（BLF-529）', () => {
  it('CardHeader 带 md:px-0，无 md:px-7 / px-6 残留', () => {
    const { header } = renderCard()
    expect(header?.className).toContain('md:px-0')
    expect(header?.className).not.toContain('md:px-7')
    expect(header?.className).not.toContain('px-6')
    expect(header?.className).toContain('p-0')
  })

  it('指标卡片正常渲染', () => {
    const { container } = renderCard()
    expect(container.textContent).toContain('指标A')
    expect(container.textContent).toContain('指标B')
  })
})
