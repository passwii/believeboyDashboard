import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { LegendItem, LegendRow, LegendSwatch, type LegendSwatchVariant } from './legend'

describe('LegendSwatch', () => {
  it.each([
    ['dot', 'rounded-full'],
    ['line', 'rounded-none'],
    ['bar', 'rounded-none'],
  ] as const)('%s 变体应用正确形状类', (variant, shapeClass) => {
    const { container } = render(<LegendSwatch variant={variant} color="hsl(var(--chart-1))" />)
    expect(container.firstElementChild?.className).toContain(shapeClass)
  })

  it('bar 变体用方块比例', () => {
    const { container } = render(<LegendSwatch variant="bar" />)
    const cls = container.firstElementChild?.className as string
    expect(cls).toContain('h-2')
    expect(cls).toContain('w-2.5')
  })

  it('dot 变体应用 color 背景色（非纯黑，走 CSS 变量）', () => {
    const { container } = render(<LegendSwatch variant="dot" color="hsl(var(--chart-1))" />)
    const el = container.firstElementChild as HTMLElement
    expect(el.style.backgroundColor).toBe('hsl(var(--chart-1))')
  })

  it('dashed 变体应用背景虚线而非纯色', () => {
    const { container } = render(<LegendSwatch variant="dashed" color="hsl(var(--chart-2))" />)
    const el = container.firstElementChild as HTMLElement
    expect(el.style.background).toContain('repeating-linear-gradient')
    expect(el.style.background).toContain('hsl(var(--chart-2))')
  })
})

describe('LegendItem', () => {
  it('渲染 label 与 swatch', () => {
    render(<LegendItem label="销售额" color="hsl(var(--chart-1))" />)
    expect(screen.getByText('销售额')).toBeInTheDocument()
  })

  it('无 onClick 时渲染为 span（非交互）', () => {
    const { container } = render(<LegendItem label="销售额" />)
    expect(container.querySelector('span')).not.toBeNull()
    expect(container.querySelector('button')).toBeNull()
  })

  it('有 onClick 时渲染为 button 并可点击', async () => {
    const onClick = vi.fn()
    render(<LegendItem label="销售额" onClick={onClick} />)
    const btn = screen.getByRole('button', { name: '销售额' })
    btn.click()
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('inactive 系列应用降透明度类（为 Stage 2 toggle 预留）', () => {
    const { container } = render(<LegendItem label="销售额" active={false} />)
    expect(container.querySelector('span')?.className).toContain('opacity-50')
  })
})

describe('LegendRow', () => {
  it('渲染多个图例项', () => {
    render(
      <LegendRow
        items={[
          { label: '销售额', color: 'hsl(var(--chart-1))', variant: 'bar' },
          { label: '销量', color: 'hsl(var(--chart-2))', variant: 'line' },
        ]}
      />
    )
    expect(screen.getByText('销售额')).toBeInTheDocument()
    expect(screen.getByText('销量')).toBeInTheDocument()
  })

  it('items 为空时不渲染', () => {
    const { container } = render(<LegendRow items={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('align=start 应用 justify-start', () => {
    const { container } = render(<LegendRow items={[{ label: 'A' }]} align="start" />)
    expect(container.firstElementChild?.className).toContain('justify-start')
  })

  it('verticalAlign=top 应用 pb-3', () => {
    const { container } = render(<LegendRow items={[{ label: 'A' }]} verticalAlign="top" />)
    expect(container.firstElementChild?.className).toContain('pb-3')
  })

  it('支持换行 flex-wrap（窄容器多条目）', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ label: `系列${i + 1}` }))
    const { container } = render(<LegendRow items={items} />)
    expect(container.firstElementChild?.className).toContain('flex-wrap')
  })
})

describe('LegendSwatchVariant type surface', () => {
  it('编译期接受四种变体', () => {
    const variants: LegendSwatchVariant[] = ['dot', 'line', 'dashed', 'bar']
    expect(variants).toHaveLength(4)
  })
})
