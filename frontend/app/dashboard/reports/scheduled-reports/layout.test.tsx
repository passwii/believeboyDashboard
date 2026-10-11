import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// BEL-422：非激活 tab 的 view 首次激活前不得挂载 —— 进入页面不应为看不到的
// tab 发起 mount 请求（订阅/台账视图各带 2-3 个）。

let mockPathname = '/dashboard/reports/scheduled-reports'
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}))
vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: () => ({ setLoading: vi.fn() }),
}))

vi.mock('./_components/SubscriptionsView', async () => {
  const React = await import('react')
  return {
    default: function SubscriptionsViewStub({ onRefreshReady }: { onRefreshReady?: (refresh: () => Promise<void>) => void }) {
      React.useEffect(() => { onRefreshReady?.(async () => {}) }, [onRefreshReady])
      return <div data-testid="subscriptions-view" />
    },
  }
})

vi.mock('./_components/LedgerView', async () => {
  const React = await import('react')
  return {
    default: function LedgerViewStub({ onRefreshReady }: { onRefreshReady?: (refresh: () => Promise<void>) => void }) {
      React.useEffect(() => { onRefreshReady?.(async () => {}) }, [onRefreshReady])
      return <div data-testid="ledger-view" />
    },
  }
})

import ScheduledReportsLayout from './layout'

describe('ScheduledReportsLayout 懒挂载（BEL-422）', () => {
  beforeEach(() => {
    mockPathname = '/dashboard/reports/scheduled-reports'
  })

  it('默认进入只挂载订阅视图，台账视图不挂载（不为其拉数）', () => {
    render(<ScheduledReportsLayout />)
    expect(screen.getByTestId('subscriptions-view')).toBeInTheDocument()
    expect(screen.queryByTestId('ledger-view')).toBeNull()
  })

  it('首次切到台账 tab 后才挂载台账视图；切回后两个视图都保持挂载（不重复拉数）', async () => {
    const user = userEvent.setup()
    render(<ScheduledReportsLayout />)
    expect(screen.queryByTestId('ledger-view')).toBeNull()

    await user.click(screen.getByRole('tab', { name: '调度记录' }))
    expect(screen.getByTestId('ledger-view')).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: '订阅管理' }))
    expect(screen.getByTestId('subscriptions-view')).toBeInTheDocument()
    expect(screen.getByTestId('ledger-view')).toBeInTheDocument()
  })

  it('深链 /ledger 进入时直接挂载台账视图，不挂载订阅视图', () => {
    mockPathname = '/dashboard/reports/scheduled-reports/ledger'
    render(<ScheduledReportsLayout />)
    expect(screen.getByTestId('ledger-view')).toBeInTheDocument()
    expect(screen.queryByTestId('subscriptions-view')).toBeNull()
  })
})
