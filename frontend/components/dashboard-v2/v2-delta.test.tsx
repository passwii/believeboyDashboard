import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { Delta, DeltaIcon, DeltaValue } from './v2-delta'

describe('v2-delta', () => {
  it('渲染绝对值 + % 后缀（默认 precision=1）', () => {
    render(
      <Delta value={-3.44}>
        <DeltaValue />
      </Delta>
    )
    expect(screen.getByText('3.4%')).toBeInTheDocument()
  })

  it('正值显示 term-pos 色', () => {
    const { container } = render(
      <Delta value={12.4}>
        <DeltaValue />
      </Delta>
    )
    expect(container.querySelector('[data-slot="delta"]')?.className).toContain('term-pos')
  })

  it('负值显示 term-neg 色', () => {
    const { container } = render(
      <Delta value={-0.4}>
        <DeltaValue />
      </Delta>
    )
    expect(container.querySelector('[data-slot="delta"]')?.className).toContain('term-neg')
  })

  it('badge variant 正值用 term-pos 背景', () => {
    const { container } = render(
      <Delta value={5} variant="badge">
        <DeltaValue />
      </Delta>
    )
    expect(container.querySelector('[data-slot="delta"]')?.className).toContain('bg-term-pos/10')
  })

  it('DeltaValue 在 Delta 外使用抛错', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<DeltaValue />)).toThrow('must be used inside a `Delta` component')
    vi.restoreAllMocks()
  })
})
