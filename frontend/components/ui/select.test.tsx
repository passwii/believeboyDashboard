import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select'

describe('Select 暗黑浮层玻璃 + 聚焦辉光（BLF-574）', () => {
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

  it('light 模式保留原 shadow-lg 浮层阴影', () => {
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
    expect(content.className).toContain('shadow-lg')
  })
})
