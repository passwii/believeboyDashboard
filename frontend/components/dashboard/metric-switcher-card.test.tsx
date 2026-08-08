import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'

import { MetricSwitcherCard, type MetricDef } from './metric-switcher-card'

// BLF-529 回归测试：指标卡片区域在 md+ 断点必须左右无内边距（占满卡片两侧）、顶部无内边距（顶对齐）。
// 背景：CardHeader 基类自带 `md:px-7 md:pb-3 md:pt-7`，若只用 `p-0` 覆盖，
// tailwind-merge 只去掉无响应式的 `px-6/pt-6/pb-3`，md 变体原样保留 ——
// 桌面端指标卡片两侧会残留 1.75rem 空隙、顶部残留 1.75rem 空白。
// 修复补 `md:px-0`（左右）+ `md:pt-0`（顶部）抵消 md 变体；底部 md:pb-3 保留给“形态”切换行。
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
  it('CardHeader 带 md:px-0 / md:pt-0，无 md:px-7 / md:pt-7 / px-6 残留', () => {
    const { header } = renderCard()
    expect(header?.className).toContain('md:px-0')
    expect(header?.className).toContain('md:pt-0')
    expect(header?.className).not.toContain('md:px-7')
    expect(header?.className).not.toContain('md:pt-7')
    expect(header?.className).not.toContain('px-6')
    expect(header?.className).toContain('p-0')
    // 底部内边距保留（“形态”切换行的呼吸空间）
    expect(header?.className).toContain('md:pb-3')
  })

  it('指标卡片正常渲染', () => {
    const { container } = renderCard()
    expect(container.textContent).toContain('指标A')
    expect(container.textContent).toContain('指标B')
  })
})
