import { cleanup, render, screen } from '@testing-library/react'
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
  useHeaderSlot: () => null,
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
})
