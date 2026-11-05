import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { WarmRouteLoading } from './warm-route-loading'

describe('WarmRouteLoading', () => {
  it('renders an accessible static Warm table skeleton', () => {
    const { container } = render(<WarmRouteLoading variant="table" columns={6} rows={4} />)

    expect(screen.getByLabelText('页面加载中')).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('status')).toHaveTextContent('页面加载中')
    expect(container.querySelector('[data-warm-loading="table"]')).toBeInTheDocument()
    const rows = Array.from(container.querySelectorAll<HTMLElement>('[style]'))
    expect(rows).toHaveLength(5)
    expect(rows.every((row) => row.getAttribute('style')?.includes('repeat(6'))).toBe(true)
    expect(container.innerHTML).not.toMatch(/term-|rounded-none|animate-pulse/)
  })

  it('preserves the dashboard and detail geometries', () => {
    const { container, rerender } = render(<WarmRouteLoading />)
    expect(container.querySelector('[data-warm-loading="dashboard"]')).toBeInTheDocument()

    rerender(<WarmRouteLoading variant="detail" label="正在加载项目详情" />)
    expect(screen.getByLabelText('正在加载项目详情')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('正在加载项目详情')
    expect(container.querySelector('[data-warm-loading="detail"]')).toBeInTheDocument()
  })
})
