import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { stableNotifications, stableSession } from '@/test-utils/stable-mocks'

vi.mock('next-auth/react', () => ({
  useSession: () => stableSession(),
}))

vi.mock('@/components/notifications', () => ({
  useNotifications: () => stableNotifications(),
}))

vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: () => undefined,
  useHeaderSlot: (node: React.ReactNode) => node,
  useMobileFilterStrip: () => null,
}))

vi.mock('./detail-tab', () => ({
  DetailTab: () => <div data-testid="detail-tab" />,
}))
vi.mock('./monthly-summary-tab', () => ({
  MonthlySummaryTab: () => <div data-testid="monthly-summary-tab" />,
}))
vi.mock('./project-summary-tab', () => ({
  ProjectSummaryTab: () => <div data-testid="project-summary-tab" />,
}))
vi.mock('./monthly-collection-tab', () => ({
  MonthlyCollectionTab: () => <div data-testid="monthly-collection-tab" />,
}))
vi.mock('./commission-rules-card', () => ({
  CommissionRulesCard: () => <div data-testid="commission-rules-card" />,
}))

import CommissionManagementPage from './page'

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] }),
      text: async () => '',
    })
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('Commission Management Warm Ledger page contract', () => {
  it('renders all four tabs inside the Warm page shell', async () => {
    const user = userEvent.setup()
    const { container } = render(<CommissionManagementPage />)
    const page = container.querySelector('[data-warm-commission-management="true"]')
    const tabList = screen.getByRole('tablist')

    expect(page).not.toBeNull()
    expect(tabList).toHaveAttribute('data-warm-tablist', 'true')
    expect(screen.getByTestId('detail-tab')).toBeInTheDocument()

    for (const label of ['总览', '年-月汇总', '项目汇总', '月度回款']) {
      const trigger = screen.getByRole('tab', { name: label })
      expect(trigger.className).not.toContain('rounded-none')
      expect(trigger.className).not.toContain('term-')
    }

    await user.click(screen.getByRole('tab', { name: '年-月汇总' }))
    expect(screen.getByTestId('monthly-summary-tab')).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: '项目汇总' }))
    expect(screen.getByTestId('project-summary-tab')).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: '月度回款' }))
    expect(screen.getByTestId('monthly-collection-tab')).toBeInTheDocument()
  })

  it('shows a retryable error instead of an empty detail state when loading fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/project-months')) {
          return {
            ok: false,
            status: 503,
            text: async () => 'service unavailable',
            json: async () => ({}),
          }
        }
        return {
          ok: true,
          status: 200,
          text: async () => '',
          json: async () => ({ items: [] }),
        }
      })
    )

    render(<CommissionManagementPage />)

    expect(await screen.findByRole('alert')).toHaveTextContent('佣金数据加载失败')
    expect(screen.queryByTestId('detail-tab')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })

  it('country changes request project-month detail only once', async () => {
    const user = userEvent.setup()
    render(<CommissionManagementPage />)
    await waitFor(() => {
      const calls = vi
        .mocked(fetch)
        .mock.calls.filter(([url]) => String(url).includes('/project-months?'))
      expect(calls).toHaveLength(1)
    })

    await user.click(screen.getByRole('combobox', { name: '站点' }))
    await user.click(await screen.findByRole('option', { name: 'US' }))

    await waitFor(() => {
      const calls = vi
        .mocked(fetch)
        .mock.calls.filter(([url]) => String(url).includes('/project-months?'))
      expect(calls).toHaveLength(2)
    })
  })
})
