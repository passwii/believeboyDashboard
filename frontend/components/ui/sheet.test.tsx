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

  it('light 模式保留原 shadow-lg 浮层阴影', () => {
    render(
      <Sheet open>
        <SheetContent side="right">
          <SheetTitle>标题</SheetTitle>
        </SheetContent>
      </Sheet>
    )
    const content = document.body.querySelector('[role="dialog"]')!
    expect(content.className).toContain('shadow-lg')
    expect(content.className).toContain('bg-background')
  })
})
