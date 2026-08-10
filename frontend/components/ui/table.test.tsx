import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { STICKY_TOP_GROUP_ROW, STICKY_TOP_ROW } from './table'

describe('Table 粘性表头暗黑顶部内高光（BLF-574）', () => {
  it('STICKY_TOP_ROW 暗黑叠加顶部内高光（与卡片玻璃边一致），light 保留底边框阴影', () => {
    expect(STICKY_TOP_ROW).toContain('shadow-[inset_0_-1px_0_0_hsl(var(--border)/0.6)]')
    expect(STICKY_TOP_ROW).toContain('dark:shadow-[inset_0_1px_0_hsl(220_30%_100%/0.05),inset_0_-1px_0_0_hsl(var(--border)/0.6)]')
  })

  it('STICKY_TOP_GROUP_ROW 暗黑带顶部内高光', () => {
    expect(STICKY_TOP_GROUP_ROW).toContain('dark:shadow-[inset_0_1px_0_hsl(220_30%_100%/0.06)]')
  })
})

describe('手机端表格全局兜底（BLF-610 规则 10）', () => {
  const css = readFileSync(join(__dirname, '../../app/globals.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    ''
  )

  it('<768px 兜底为 max-content：表格保持桌面同宽需求、容器横滑，不再压缩折行', () => {
    expect(css).toContain('min-width: max-content')
    expect(css).toContain('@media (max-width: 768px)')
    // 旧的固定 600px 下限不允许回潮（它仍会把宽表压缩到 600px 导致折行）
    expect(css).not.toContain('min-width: 600px')
  })

  it('兜底覆盖 Table 原语 wrapper（overflow-x-auto）与 dashboard-surface/panel 内表格', () => {
    expect(css).toContain('.dashboard-surface table')
    expect(css).toContain('.dashboard-panel table')
    expect(css).toContain('[class*="overflow-x-auto"] table')
  })
})
