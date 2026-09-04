import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Checkbox } from './checkbox'

describe('Checkbox Terminal 收口（BLF-870）', () => {
  it('基类为零圆角 + term 边界 + term 背景 + u-focus-glow（无 rounded-sm/border-primary）', () => {
    const { container } = render(<Checkbox />)
    const el = container.querySelector('[role="checkbox"]') as HTMLElement
    expect(el.className).toContain('rounded-none')
    expect(el.className).toContain('border-term-border')
    expect(el.className).toContain('bg-term-bg')
    expect(el.className).toContain('u-focus-glow')
    expect(el.className).toContain('shadow-none')
    expect(el.className).not.toContain('rounded-sm')
  })
})
