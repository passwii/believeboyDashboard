import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Textarea } from './textarea'

describe('Textarea 暗黑聚焦辉光（BLF-574，保留）', () => {
  it('带 u-focus-glow 工具类（暗黑聚焦态蓝辉光钩子）', () => {
    const { container } = render(<Textarea placeholder="备注" />)
    const textarea = container.querySelector('textarea')!
    expect(textarea.className).toMatch(/\bu-focus-glow\b/)
  })

  it('聚焦时边框收敛到 term 令牌', () => {
    const { container } = render(<Textarea />)
    expect(container.querySelector('textarea')!.className).toContain('focus-visible:border-term-border-strong')
  })
})

describe('Textarea Terminal 收口（BLF-869）', () => {
  it('基类为零圆角 + 1px term 边界 + term 背景 + mono 小字', () => {
    const { container } = render(<Textarea />)
    const cls = container.querySelector('textarea')!.className
    expect(cls).toContain('rounded-none')
    expect(cls).toContain('border-term-border')
    expect(cls).toContain('bg-term-bg')
    expect(cls).toContain('font-mono')
    expect(cls).not.toContain('rounded-md')
    expect(cls).not.toContain('border-input')
  })

  it('占位与错误态对齐 term 令牌', () => {
    const { container } = render(<Textarea placeholder="x" aria-invalid />)
    const cls = container.querySelector('textarea')!.className
    expect(cls).toContain('placeholder:text-term-faint')
    expect(cls).toContain('aria-[invalid=true]:border-term-neg')
  })

  it('高度仍由 min-h 档位控制（不引入 h-8）', () => {
    const { container: d } = render(<Textarea />)
    expect(d.querySelector('textarea')!.className).toContain('min-h-[80px]')
    const { container: sm } = render(<Textarea size="sm" />)
    expect(sm.querySelector('textarea')!.className).toContain('min-h-[60px]')
    const { container: lg } = render(<Textarea size="lg" />)
    expect(lg.querySelector('textarea')!.className).toContain('min-h-[120px]')
  })
})
