import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Badge } from './badge'

describe('Badge Terminal 收口（BLF-872）', () => {
  it('基座：零圆角 + mono 小字 + 零阴影（去除暗黑玻璃内高光）', () => {
    const { container } = render(<Badge>标签</Badge>)
    const badge = container.querySelector('div')!
    expect(badge.className).toContain('rounded-none')
    expect(badge.className).toContain('font-mono')
    expect(badge.className).toContain('shadow-none')
    expect(badge.className).not.toContain('dark:shadow-[inset_0_1px_0_hsl')
  })

  it('outline 变体走 term 边框/面板（实体不透明，不再半透明）', () => {
    const { container } = render(<Badge variant="outline">标签</Badge>)
    const badge = container.querySelector('div')!
    expect(badge.className).toContain('border-term-border')
    expect(badge.className).toContain('bg-term-panel')
    expect(badge.className).toContain('text-term-text')
  })

  it('语义变体保留 dark 边框调校（状态色语义不变）', () => {
    const { container } = render(<Badge variant="secondary">标签</Badge>)
    const badge = container.querySelector('div')!
    expect(badge.className).toContain('dark:border-secondary/20')
  })
})
