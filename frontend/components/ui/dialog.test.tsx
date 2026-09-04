import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Dialog, DialogContent, DialogTitle } from './dialog'

describe('Dialog 暗黑浮层玻璃（BLF-574）', () => {
  it('内容带 u-floating-glass（暗黑 Level 5 玻璃+辉光）', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>标题</DialogTitle>
        </DialogContent>
      </Dialog>
    )
    const content = document.body.querySelector('[role="dialog"]')!
    expect(content.className).toContain('u-floating-glass')
    // 字面量阴影已迁移到 token（--shadow-level-5），不应残留
    expect(content.className).not.toContain('dark:shadow-[0_24px_48px')
  })

  it('浮层 Terminal 令牌（border-term-border / bg-term-panel / rounded-none / shadow-none）', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>标题</DialogTitle>
        </DialogContent>
      </Dialog>
    )
    const content = document.body.querySelector('[role="dialog"]')!
    expect(content.className).toContain('border-term-border')
    expect(content.className).toContain('bg-term-panel')
    expect(content.className).toContain('rounded-none')
    expect(content.className).toContain('shadow-none')
    expect(content.className).not.toContain('shadow-lg')
    expect(content.className).not.toContain('bg-background')
  })
})
