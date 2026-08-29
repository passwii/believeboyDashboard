import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Input } from './input'

describe('Input 暗黑聚焦辉光（BLF-574，保留）', () => {
  it('带 u-focus-glow 工具类（暗黑聚焦态蓝辉光钩子）', () => {
    const { container } = render(<Input placeholder="搜索" />)
    const input = container.querySelector('input')!
    expect(input.className).toMatch(/\bu-focus-glow\b/)
  })

  it('聚焦时边框收敛到 term 令牌（focus-visible:border-term-border-strong）', () => {
    const { container } = render(<Input />)
    const input = container.querySelector('input')!
    expect(input.className).toContain('focus-visible:border-term-border-strong')
  })
})

describe('Input Terminal 收口（BLF-869）', () => {
  it('基类为零圆角 + 1px term 边界 + term 背景 + mono 小字', () => {
    const { container } = render(<Input />)
    const cls = container.querySelector('input')!.className
    expect(cls).toContain('rounded-none')
    expect(cls).toContain('border-term-border')
    expect(cls).toContain('bg-term-bg')
    expect(cls).toContain('font-mono')
    expect(cls).toContain('text-sm')
    expect(cls).not.toContain('rounded-md')
    expect(cls).not.toContain('border-input')
    expect(cls).not.toContain('bg-background')
  })

  it('占位与禁用态对齐 term 令牌', () => {
    const { container } = render(<Input placeholder="x" disabled />)
    const cls = container.querySelector('input')!.className
    expect(cls).toContain('placeholder:text-term-faint')
    expect(cls).toContain('disabled:opacity-50')
    expect(cls).toContain('disabled:cursor-not-allowed')
  })

  it('错误态由 aria-invalid 驱动（border-term-neg）', () => {
    const { container } = render(<Input aria-invalid />)
    expect(container.querySelector('input')!.className).toContain('aria-[invalid=true]:border-term-neg')
  })

  it('高度档位收敛到 h-9 / h-8 / h-10（BLF-887 上档；无 h-11 大触摸）', () => {
    const { container: d } = render(<Input />)
    expect(d.querySelector('input')!.className).toContain('h-9')
    expect(d.querySelector('input')!.className).not.toContain('min-h-touch')
    const { container: sm } = render(<Input size="sm" />)
    expect(sm.querySelector('input')!.className).toContain('h-8')
    const { container: lg } = render(<Input size="lg" />)
    expect(lg.querySelector('input')!.className).toContain('h-10')
  })

  it('无独立阴影漂移（shadow-none，聚焦走 border + u-focus-glow）', () => {
    const { container } = render(<Input />)
    const cls = container.querySelector('input')!.className
    expect(cls).toContain('shadow-none')
    expect(cls).not.toMatch(/shadow-sm|shadow-black/)
  })
})
