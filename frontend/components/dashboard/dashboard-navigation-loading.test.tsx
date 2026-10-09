import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DashboardNavigationLoading } from './dashboard-navigation-loading'

describe('DashboardNavigationLoading', () => {
  it('announces the destination and shows a terminal-style page skeleton', () => {
    render(<DashboardNavigationLoading targetPath="/dashboard/operations/daily-analysis" />)

    expect(screen.getByRole('region', { name: '正在加载销售数据' })).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('heading', { name: '销售数据' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('正在打开销售数据')
    expect(document.querySelectorAll('.u-skeleton-shimmer').length).toBeGreaterThan(0)
  })

  it('uses a neutral title when the destination is unknown', () => {
    render(<DashboardNavigationLoading targetPath="/dashboard/new-page" />)

    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('正在打开Dashboard')
  })
})
