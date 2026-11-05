import type { ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import DashboardV2Loading from './loading'

const routeState = vi.hoisted(() => ({ pathname: '/dashboard' }))

vi.mock('next/navigation', () => ({
  usePathname: () => routeState.pathname,
}))

vi.mock('@/components/dashboard-v2/warm-ledger/shell/warm-ledger-shell', () => ({
  WarmLedgerShell: ({ children }: { children: ReactNode }) => (
    <div data-testid="home-loading-shell">{children}</div>
  ),
}))

describe('DashboardV2Loading', () => {
  beforeEach(() => {
    routeState.pathname = '/dashboard'
  })

  it('renders the home skeleton inside the Warm shell', () => {
    render(<DashboardV2Loading />)

    expect(screen.getByTestId('home-loading-shell')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('正在加载运营总览')
  })

  it('does not add a nested shell for framed routes', () => {
    routeState.pathname = '/dashboard/operations/daily-analysis'
    render(<DashboardV2Loading />)

    expect(screen.queryByTestId('home-loading-shell')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('页面加载中')
  })
})
