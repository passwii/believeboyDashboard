import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { BelieveboyMark, BelieveboyLockup } from './believeboy-mark'

describe('BelieveboyMark', () => {
  it('默认渲染 wing 方向并暴露可访问名称', () => {
    const { container } = render(<BelieveboyMark />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg).toHaveAttribute('viewBox', '0 0 64 64')
    expect(screen.getByRole('img', { name: 'Believeboy · Wing-cut B' })).toBeVisible()
    expect(svg?.querySelector('path')).toHaveAttribute('fill-rule', 'evenodd')
  })

  it('装饰性用法可以隐藏语义', () => {
    const { container } = render(<BelieveboyMark label={null} />)
    const svg = container.querySelector('svg')
    expect(svg).toHaveAttribute('aria-hidden', 'true')
    expect(svg).not.toHaveAttribute('aria-label')
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('切换方向会换 path 常量', () => {
    const { container: wing } = render(<BelieveboyMark direction="wing" />)
    const { container: ledger } = render(<BelieveboyMark direction="ledger" />)
    const wingD = wing.querySelector('path')?.getAttribute('d')
    const ledgerD = ledger.querySelector('path')?.getAttribute('d')
    expect(wingD).toBeTruthy()
    expect(ledgerD).toBeTruthy()
    expect(wingD).not.toBe(ledgerD)
  })
})

describe('BelieveboyLockup', () => {
  it('渲染 mark + 字标，mark 不重复可访问名称', () => {
    const { container } = render(<BelieveboyLockup />)
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByText('believeboy')).toBeVisible()
    // 锁合本身就是品牌名，不需要第二个 img role
    expect(screen.queryByRole('img', { name: /Believeboy/ })).not.toBeInTheDocument()
  })

  it('mark 尺寸与字标大小按 props 生效', () => {
    const { container } = render(<BelieveboyLockup markSize={28} wordmarkSize={16} />)
    const svg = container.querySelector('svg') as SVGSVGElement
    expect(svg.style.width).toBe('28px')
    expect(svg.style.height).toBe('28px')
    expect((container.querySelector('span') as HTMLElement).style.fontSize).toBe('16px')
  })
})
