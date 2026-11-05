import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const CSS = readFileSync(
  join(process.cwd(), 'app/dashboard/reports/scheduled-reports/scheduled-reports-warm.module.css'),
  'utf8'
)

function cssBlock(selector: string): string {
  const start = CSS.indexOf(selector)
  expect(start, `missing CSS selector: ${selector}`).toBeGreaterThanOrEqual(0)
  const open = CSS.indexOf('{', start)
  const close = CSS.indexOf('}', open)
  return CSS.slice(open + 1, close)
}

describe('scheduled reports Warm 样式契约', () => {
  it('input 键盘焦点使用高对比 Warm outline、边框与 ring', () => {
    const focus = cssBlock('.input:focus-visible')

    expect(focus).toContain('outline: var(--warm-ledger-focus-width) solid')
    expect(focus).toContain('outline-color: var(--warm-ledger-focus-color)')
    expect(focus).toContain('border-color: var(--warm-ledger-color-accent-strong)')
    expect(focus).toContain('box-shadow:')
  })

  it('按钮基础样式不压住 hover 与 danger 边框', () => {
    const base = cssBlock('.button,')

    expect(base).not.toMatch(/background:[^;]+!important/)
    expect(base).not.toMatch(/border:[^;]+!important/)
    expect(cssBlock('.buttonDanger:hover:not(:disabled)')).toContain('border-color:')
  })

  it('选中订阅行 hover 时继续保持选中强调', () => {
    const selectedHover = cssBlock('.selectedRow:hover')

    expect(selectedHover).toContain('background: var(--warm-ledger-color-raised)')
  })

  it('普通 muted 文本使用 sans，数值仍使用 mono', () => {
    expect(cssBlock('.mutedCell')).toContain(
      'font-family: var(--warm-ledger-font-sans)'
    )
    expect(cssBlock('.numeric')).toContain(
      'font-family: var(--warm-ledger-font-mono)'
    )
  })

  it('时间与模型用复合专用选择器确保最终 mono，不依赖声明顺序', () => {
    expect(cssBlock('.mutedCell.timeCell')).toContain(
      'font-family: var(--warm-ledger-font-mono)'
    )
    expect(cssBlock('.mobileMeta.mobileTime')).toContain(
      'font-family: var(--warm-ledger-font-mono)'
    )
    expect(cssBlock('.mobileMeta.modelCell')).toContain(
      'font-family: var(--warm-ledger-font-mono)'
    )
  })
})
