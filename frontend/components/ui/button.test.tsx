import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Button } from './button'

describe('Button motion classes', () => {
  it('includes motion utility classes (u-press / u-focus / u-interactive)', () => {
    const { container } = render(<Button>x</Button>)
    const btn = container.querySelector('button')!
    const cls = btn.className
    expect(cls).toMatch(/\bu-press\b/)
    expect(cls).toMatch(/\bu-focus\b/)
    expect(cls).toMatch(/\bu-interactive\b/)
    expect(cls).toMatch(/focus-visible:outline/)
  })

  it('honours disabled (no transform target)', () => {
    const { container } = render(<Button disabled>x</Button>)
    const btn = container.querySelector('button')!
    expect(btn.hasAttribute('disabled')).toBe(true)
  })
})

describe('Button 暗黑 macOS 原生按压（BLF-574）', () => {
  const variantsWithPress = ['default', 'destructive', 'outline', 'secondary'] as const

  it.each(variantsWithPress)('%s 变体带 u-btn（暗黑 L3 按压钩子）', (variant) => {
    const { container } = render(<Button variant={variant}>x</Button>)
    const btn = container.querySelector('button')!
    expect(btn.className).toMatch(/\bu-btn\b/)
  })

  it('ghost / link 保持无边框语言（不带 u-btn）', () => {
    const { container: ghost } = render(<Button variant="ghost">x</Button>)
    expect(ghost.querySelector('button')!.className).not.toMatch(/\bu-btn\b/)
    const { container: link } = render(<Button variant="link">x</Button>)
    expect(link.querySelector('button')!.className).not.toMatch(/\bu-btn\b/)
  })

  it('outline 暗黑 hover 用透明度过渡（dark:hover:bg-accent/70，不大色块跳变）', () => {
    const { container } = render(<Button variant="outline">x</Button>)
    const btn = container.querySelector('button')!
    expect(btn.className).toContain('dark:hover:bg-accent/70')
  })
})
