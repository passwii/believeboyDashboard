import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Input } from './input'

describe('Input 暗黑聚焦辉光（BLF-574）', () => {
  it('带 u-focus-glow 工具类（暗黑聚焦态蓝辉光钩子）', () => {
    const { container } = render(<Input placeholder="搜索" />)
    const input = container.querySelector('input')!
    expect(input.className).toMatch(/\bu-focus-glow\b/)
  })

  it('暗黑背景对齐近黑蓝调（surface-soft），light 背景不变', () => {
    const { container } = render(<Input />)
    const input = container.querySelector('input')!
    expect(input.className).toContain('dark:bg-[hsl(var(--surface-soft)/0.96)]')
    expect(input.className).toContain('bg-background')
  })

  it('保留 light 聚焦环（focus-visible:ring-2），light 模式零变化', () => {
    const { container } = render(<Input />)
    const input = container.querySelector('input')!
    expect(input.className).toMatch(/focus-visible:ring-2/)
    expect(input.className).toMatch(/focus-visible:ring-ring/)
  })
})
