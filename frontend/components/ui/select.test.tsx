import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select'

describe('Select 暗黑浮层玻璃 + 聚焦辉光（BLF-574，保留）', () => {
  it('触发器带 u-focus-glow（暗黑聚焦态蓝辉光钩子）', () => {
    render(
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="选择" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">A</SelectItem>
        </SelectContent>
      </Select>
    )
    const trigger = screen.getByRole('combobox')
    expect(trigger.className).toMatch(/\bu-focus-glow\b/)
  })

  it('浮层内容带 u-floating-glass（暗黑 Level 5 玻璃+辉光）', () => {
    render(
      <Select open>
        <SelectTrigger>
          <SelectValue placeholder="选择" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">A</SelectItem>
        </SelectContent>
      </Select>
    )
    const content = document.body.querySelector('[role="listbox"]')!
    expect(content.className).toContain('u-floating-glass')
    // 字面量阴影已迁移到 token（--shadow-level-5），不应残留
    expect(content.className).not.toContain('dark:shadow-[0_24px_48px')
  })
})

describe('Select Terminal 收口（BLF-869）', () => {
  it('Trigger 高度收敛到 h-8 零圆角 + term 令牌（无 h-10/min-h-touch/shadow-sm）', () => {
    render(
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="选择" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">A</SelectItem>
        </SelectContent>
      </Select>
    )
    const trigger = screen.getByRole('combobox')
    expect(trigger.className).toContain('h-8')
    expect(trigger.className).toContain('rounded-none')
    expect(trigger.className).toContain('border-term-border')
    expect(trigger.className).toContain('bg-term-bg')
    expect(trigger.className).toContain('font-mono')
    expect(trigger.className).not.toContain('h-10')
    expect(trigger.className).not.toContain('min-h-touch')
    expect(trigger.className).not.toContain('rounded-md')
    expect(trigger.className).not.toContain('shadow-sm')
    expect(trigger.className).not.toContain('border-input')
  })

  it('Trigger 占位与错误态对齐 term 令牌', () => {
    render(
      <Select>
        <SelectTrigger aria-invalid>
          <SelectValue placeholder="选择" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">A</SelectItem>
        </SelectContent>
      </Select>
    )
    const trigger = screen.getByRole('combobox')
    expect(trigger.className).toContain('data-[placeholder]:text-term-faint')
    expect(trigger.className).toContain('aria-[invalid=true]:border-term-neg')
  })

  it('Content 背景与边框收口到 term 令牌（bg-term-panel / border-term-border）', () => {
    render(
      <Select open>
        <SelectTrigger>
          <SelectValue placeholder="选择" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">A</SelectItem>
        </SelectContent>
      </Select>
    )
    const content = document.body.querySelector('[role="listbox"]')!
    expect(content.className).toContain('bg-term-panel')
    expect(content.className).toContain('border-term-border')
    expect(content.className).toContain('rounded-none')
    expect(content.className).not.toContain('bg-popover')
    expect(content.className).not.toContain('border-input')
  })

  it('Item 零圆角 + mono + term hover（focus:bg-term-hover）', () => {
    render(
      <Select open>
        <SelectTrigger>
          <SelectValue placeholder="选择" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">A</SelectItem>
        </SelectContent>
      </Select>
    )
    const item = document.body.querySelector('[role="option"]')!
    expect(item.className).toContain('rounded-none')
    expect(item.className).toContain('font-mono')
    expect(item.className).toContain('focus:bg-term-hover')
    expect(item.className).not.toContain('rounded-md')
  })
})
