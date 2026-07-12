import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DashboardSurfaceCard } from './dashboard-surface-card'

// useSpotlight 已被验证，这里只断言包装组件渲染 children + 应用 dashboard-surface 类
describe('DashboardSurfaceCard', () => {
  it('renders children inside .dashboard-surface', () => {
    const { container } = render(
      <DashboardSurfaceCard><span data-testid="c">x</span></DashboardSurfaceCard>,
    )
    expect(screen.getByTestId('c')).toBeInTheDocument()
    expect(container.querySelector('.dashboard-surface')).toBeTruthy()
  })

  it('forwards className', () => {
    const { container } = render(
      <DashboardSurfaceCard className="extra"><span>x</span></DashboardSurfaceCard>,
    )
    expect(container.firstChild).toHaveClass('extra')
    expect(container.firstChild).toHaveClass('dashboard-surface')
  })
})
