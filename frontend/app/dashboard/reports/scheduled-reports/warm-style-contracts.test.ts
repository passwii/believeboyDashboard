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

describe('scheduled reports 桌面/可读性修复契约', () => {
  it('.mobileList 在桌面断点强制 display:none，避免表格与手机卡片重复渲染', () => {
    const start = CSS.indexOf('@media (min-width: 768px)')
    expect(start, 'missing desktop guard media query').toBeGreaterThanOrEqual(0)
    const block = CSS.slice(start)
    expect(block).toContain('.mobileList')
    expect(block).toMatch(/\.mobileList\s*\{[^}]*display:\s*none/)
  })

  it('列表正文最小字号提升到 13px，避免 11px 难读', () => {
    expect(cssBlock('.mutedCell')).toContain('font-size: 13px')
    expect(CSS).toMatch(/\.mobileMeta\s*\{[^}]*font-size:\s*13px/)
  })

  it('弹窗正文使用 Warm panel 实色背景，不依赖 body 上的兜底变量', () => {
    const dialog = cssBlock('.dialogContent')
    expect(dialog).toContain('background: var(--warm-ledger-color-panel)')
    expect(dialog).not.toContain('background: transparent')
    expect(dialog).toContain('color: var(--warm-ledger-color-text)')
  })
})
