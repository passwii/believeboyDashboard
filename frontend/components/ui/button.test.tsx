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

  it('outline 终端化 hover 用 term 边界/背景（BLF-868，零圆角 1px 边）', () => {
    const { container } = render(<Button variant="outline">x</Button>)
    const btn = container.querySelector('button')!
    expect(btn.className).toContain('border-term-border')
    expect(btn.className).toContain('hover:bg-term-hover')
  })
})

describe('Button Terminal 收口（BLF-868）', () => {
  it('基类为零圆角 + mono 小字 + h-8（与 Terminal 令牌一致）', () => {
    const { container } = render(<Button>x</Button>)
    const cls = container.querySelector('button')!.className
    expect(cls).toContain('rounded-none')
    expect(cls).toContain('font-mono')
    expect(cls).toContain('text-xs')
    expect(cls).toContain('h-8')
  })

  it('size 档位收敛到 h-8 / h-7 / h-9（无 h-11/h-12 大圆角）', () => {
    const { container: d } = render(<Button size="default">x</Button>)
    expect(d.querySelector('button')!.className).toContain('h-8')
    expect(d.querySelector('button')!.className).not.toContain('rounded-md')
    const { container: sm } = render(<Button size="sm">x</Button>)
    expect(sm.querySelector('button')!.className).toContain('h-7')
    const { container: lg } = render(<Button size="lg">x</Button>)
    expect(lg.querySelector('button')!.className).toContain('h-9')
    const { container: xs } = render(<Button size="xs">x</Button>)
    expect(xs.querySelector('button')!.className).toContain('h-7')
  })

  it('term 变体可用且带 u-btn 与 term 边界', () => {
    const { container } = render(<Button variant="term">x</Button>)
    const cls = container.querySelector('button')!.className
    expect(cls).toMatch(/\bu-btn\b/)
    expect(cls).toContain('border-term-border')
    expect(cls).toContain('bg-term-panel')
  })

  it('ghost 保持无边框语言（border-transparent）', () => {
    const { container } = render(<Button variant="ghost">x</Button>)
    expect(container.querySelector('button')!.className).toContain('border-transparent')
  })
})
