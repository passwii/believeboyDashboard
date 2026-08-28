import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { STICKY_TOP_GROUP_ROW, STICKY_TOP_ROW, STICKY_TOP_SUB_ROW } from './table'

describe('Table 粘性表头 term 令牌（BLF-872）', () => {
  it('STICKY_TOP_ROW 走 term-raised 实体背景 + term-border 底部分隔线（去除暗黑玻璃高光）', () => {
    expect(STICKY_TOP_ROW).toContain('bg-term-raised')
    expect(STICKY_TOP_ROW).toContain('shadow-[inset_0_-1px_0_0_var(--term-border)]')
    expect(STICKY_TOP_ROW).not.toContain('dark:shadow-')
  })

  it('STICKY_TOP_GROUP_ROW 仅保留 z-index 分层（暗黑高光已移除）', () => {
    expect(STICKY_TOP_GROUP_ROW).toBe('sticky top-0 z-50')
  })

  it('STICKY_TOP_SUB_ROW offset 与默认表头高度对齐（h-9 36px + 1px 边框 = 37px）', () => {
    expect(STICKY_TOP_SUB_ROW).toContain('top-[37px]')
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

  it('兜底覆盖 Table 原语 wrapper（overflow-x-auto）与 dashboard-surface/panel/term 面板内表格', () => {
    expect(css).toContain('.dashboard-surface table')
    expect(css).toContain('.dashboard-panel table')
    expect(css).toContain('[class*="bg-term-panel"] table')
    expect(css).toContain('[class*="overflow-x-auto"] table')
  })
})
