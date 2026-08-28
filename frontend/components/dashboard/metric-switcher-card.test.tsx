import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'

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
