import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Badge } from './badge'

describe('Badge 暗黑玻璃边高光（BLF-574）', () => {
  it('默认变体带暗黑顶部内高光（与卡片同一语言）', () => {
    const { container } = render(<Badge>标签</Badge>)
    const badge = container.querySelector('div')!
    expect(badge.className).toContain('dark:shadow-[inset_0_1px_0_hsl')
  })

  it('所有变体共享同一暗黑高光基座', () => {
    const { container } = render(<Badge variant="secondary">标签</Badge>)
    const badge = container.querySelector('div')!
    expect(badge.className).toContain('dark:shadow-[inset_0_1px_0_hsl')
    expect(badge.className).toContain('dark:border-secondary/20')
  })
})
