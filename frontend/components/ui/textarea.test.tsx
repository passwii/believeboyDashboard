import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Textarea } from './textarea'

describe('Textarea 暗黑聚焦辉光（BLF-574）', () => {
  it('带 u-focus-glow 工具类（暗黑聚焦态蓝辉光钩子）', () => {
    const { container } = render(<Textarea placeholder="备注" />)
    const textarea = container.querySelector('textarea')!
    expect(textarea.className).toMatch(/\bu-focus-glow\b/)
  })

  it('暗黑背景对齐近黑蓝调（surface-soft），light 背景不变', () => {
    const { container } = render(<Textarea />)
    const textarea = container.querySelector('textarea')!
    expect(textarea.className).toContain('dark:bg-[hsl(var(--surface-soft)/0.96)]')
    expect(textarea.className).toContain('bg-background')
  })

  it('保留 light 聚焦环（focus-visible:ring-2），light 模式零变化', () => {
    const { container } = render(<Textarea />)
    const textarea = container.querySelector('textarea')!
    expect(textarea.className).toMatch(/focus-visible:ring-2/)
  })
})
