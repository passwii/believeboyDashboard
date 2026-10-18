import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Sheet, SheetContent, SheetTitle } from './sheet'

describe('Sheet 暗黑浮层玻璃（BLF-574）', () => {
  it('内容带 u-floating-glass（暗黑 Level 5 玻璃+辉光）', () => {
    render(
      <Sheet open>
        <SheetContent side="right">
          <SheetTitle>标题</SheetTitle>
        </SheetContent>
      </Sheet>
    )
    const content = document.body.querySelector('[role="dialog"]')!
    expect(content.className).toContain('u-floating-glass')
  })

  it('浮层 Terminal 令牌（border-term-border / bg-term-panel / shadow-none）', () => {
    render(
      <Sheet open>
        <SheetContent side="right">
          <SheetTitle>标题</SheetTitle>
        </SheetContent>
      </Sheet>
    )
    const content = document.body.querySelector('[role="dialog"]')!
    expect(content.className).toContain('border-term-border')
    expect(content.className).toContain('bg-term-panel')
    expect(content.className).toContain('shadow-none')
    expect(content.className).not.toContain('shadow-lg')
    expect(content.className).not.toContain('bg-background')
  })

  /* Phase B（transitions.dev 07-panel-reveal）：`globals.css` 的 .ui-panel-motion 用
   * `[data-side='right'|'left'|'top'|'bottom']` 选位移方向（--ui-panel-tx/ty）。
   * 这两个契约（class + data-side）缺任一，面板就只会淡入/模糊、不做位移——回归挡住。 */
  it('面板动效契约：ui-panel-motion + data-side（方向选择器的前提）', () => {
    render(
      <Sheet open>
        <SheetContent side="right">
          <SheetTitle>标题</SheetTitle>
        </SheetContent>
      </Sheet>
    )
    const content = document.body.querySelector('[role="dialog"]')!
    expect(content.className).toContain('ui-panel-motion')
    expect(content.getAttribute('data-side')).toBe('right')
    expect(content.className).not.toContain('animate-sheet-in-from')
  })
})
