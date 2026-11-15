import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const engineMock = {
  tick: vi.fn(),
}

vi.mock('@/components/ui/liquid-glass-logo-reveal', () => ({
  // jsdom 没有 WebGL2；草稿封装只负责预置合并与透传，渲染细节由上游自己的测试覆盖。
  GlassIconReveal: (props: Record<string, unknown>) => (
    <div
      data-testid="glass-reveal-stub"
      role="img"
      aria-label={props.label as string}
      data-logo={(props.logo as string).includes('M11.5') ? 'wing' : 'other'}
      data-background={props.background as string}
      data-look={props.look as string}
      data-keep-plate={String(props.keepPlate)}
      data-icon-plate={String(props.iconPlate)}
      data-tuning={JSON.stringify(props.tuning)}
      data-class={props.className as string}
    />
  ),
}))

import { BelieveboyGlassReveal } from './believeboy-glass-reveal'

describe('BelieveboyGlassReveal', () => {
  beforeEach(() => {
    engineMock.tick.mockClear()
  })

  it('wing-cut 收束成应用图标，使用钴蓝方片与白 B', () => {
    render(<BelieveboyGlassReveal />)
    const stub = screen.getByTestId('glass-reveal-stub')
    expect(stub).toHaveAttribute('data-look', 'light')
    expect(stub).toHaveAttribute('data-background', '#e9e9eb')
    expect(stub).toHaveAttribute('data-keep-plate', 'true')
    expect(stub).toHaveAttribute('data-icon-plate', 'true')
    expect(stub).toHaveAttribute('data-logo', 'wing')
    const tuning = JSON.parse(stub.getAttribute('data-tuning') as string)
    expect(tuning.corner).toBe(5)
    expect(tuning.startSize).toBe(0.1)
    expect(stub).toHaveAttribute('data-class', 'h-full w-full')
  })

  it('暗色预置换背景与玻璃色，但保留 same mark', () => {
    render(<BelieveboyGlassReveal tone="dark" />)
    const stub = screen.getByTestId('glass-reveal-stub')
    expect(stub).toHaveAttribute('data-background', '#101319')
    expect(stub).toHaveAttribute('data-look', 'dark')
  })

  it('prism 与 bare 不复用 wing-cut 的收束', () => {
    const { rerender } = render(<BelieveboyGlassReveal variant="prism" />)
    let stub = screen.getByTestId('glass-reveal-stub')
    expect(stub).toHaveAttribute('data-keep-plate', 'false')
    expect(stub).toHaveAttribute('data-icon-plate', 'false')

    rerender(<BelieveboyGlassReveal variant="bare" />)
    stub = screen.getByTestId('glass-reveal-stub')
    const tuning = JSON.parse(stub.getAttribute('data-tuning') as string)
    expect(tuning.dispersion).toBe(2.0)
    expect(tuning.startZoom).toBe(2.2)
  })

  it('background 与 tuning 覆盖预置', () => {
    render(<BelieveboyGlassReveal background="#ffffff" tuning={{ dispersion: 3 }} />)
    const stub = screen.getByTestId('glass-reveal-stub')
    expect(stub).toHaveAttribute('data-background', '#ffffff')
    const tuning = JSON.parse(stub.getAttribute('data-tuning') as string)
    expect(tuning.dispersion).toBe(3)
    expect(tuning.corner).toBe(5)
  })

  it('mark 方向透传给 SVG 标记', () => {
    render(<BelieveboyGlassReveal mark="ledger" />)
    expect(screen.getByTestId('glass-reveal-stub')).toHaveAttribute('data-logo', 'other')
  })

  it('默认 label 是 Believeboy，可覆盖', () => {
    const { rerender } = render(<BelieveboyGlassReveal />)
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', 'Believeboy')
    rerender(<BelieveboyGlassReveal label="Believeboy 飞翼" />)
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', 'Believeboy 飞翼')
  })
})
