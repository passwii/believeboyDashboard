import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Popover, PopoverContent } from './popover'

const floatingGlassEl = () => document.body.querySelector('.u-floating-glass')

describe('Popover 暗黑浮层玻璃（BLF-574）', () => {
  it('内容带 u-floating-glass（暗黑 Level 5 玻璃+辉光）', () => {
    render(
      <Popover open>
        <PopoverContent>内容</PopoverContent>
      </Popover>
    )
    const content = floatingGlassEl()!
    expect(content).toBeTruthy()
    expect(content.className).toContain('u-floating-glass')
    // 字面量阴影已迁移到 token（--shadow-level-5），不应残留
    expect(content.className).not.toContain('dark:shadow-[0_24px_48px')
  })

  it('light 模式 Terminal 浮层无独立阴影（shadow-none + term 令牌，BLF-870）', () => {
    render(
      <Popover open>
        <PopoverContent>内容</PopoverContent>
      </Popover>
    )
    const content = floatingGlassEl()!
    expect(content.className).toContain('shadow-none')
    expect(content.className).toContain('bg-term-panel')
    expect(content.className).toContain('border-term-border')
    expect(content.className).toContain('rounded-none')
    expect(content.className).not.toContain('shadow-lg')
    expect(content.className).not.toContain('bg-popover')
  })
})
