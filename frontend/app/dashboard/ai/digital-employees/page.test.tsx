import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DigitalEmployee } from '@/types/digital-employee'

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  mutate: vi.fn(),
  open: vi.fn(),
  headerRefresh: null as null | (() => void | Promise<void>),
  headerRefreshLoading: null as null | boolean,
}))

const EMPLOYEES: DigitalEmployee[] = [
  {
    id: 1,
    name: '报表快递员',
    description: '同步昨日报表',
    avatar_url: null,
    employee_type: 'AUTO_REPORT_UPLOAD',
    status: 'RUNNING',
    last_heartbeat_at: '2026-11-04T12:00:00Z',
    is_silent_alert_threshold_minutes: 30,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 2,
    name: '库存观察员',
    description: null,
    avatar_url: null,
    employee_type: 'MONITORING',
    status: 'FAILED',
    last_heartbeat_at: null,
    is_silent_alert_threshold_minutes: 15,
    created_at: '2026-01-02T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
  },
  {
    id: 3,
    name: '定时指挥官',
    description: null,
    avatar_url: null,
    employee_type: 'SCHEDULED_JOB',
    status: 'IDLE',
    last_heartbeat_at: '2026-11-04T11:55:00Z',
    is_silent_alert_threshold_minutes: 30,
    created_at: '2026-01-03T00:00:00Z',
    updated_at: '2026-01-03T00:00:00Z',
  },
]

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
}))

vi.mock('@/hooks/use-digital-employees', () => ({
  useDigitalEmployees: () => ({
    employees: EMPLOYEES,
    isLoading: false,
    error: null,
    mutate: mocks.mutate,
  }),
}))

vi.mock('@/components/digital-employee/activity-feed', () => ({
  ActivityFeed: () => <div data-testid="activity-feed" />,
}))

vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: (
    handler: () => void | Promise<void>,
    options?: { loading?: boolean },
  ) => {
    mocks.headerRefresh = handler
    mocks.headerRefreshLoading = options?.loading ?? null
  },
}))

import DigitalEmployeesPage from './page'

describe('DigitalEmployeesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.headerRefresh = null
    vi.stubGlobal('open', mocks.open)
  })

  it('renders the Warm roster while preserving search and status filtering', async () => {
    const user = userEvent.setup()
    const { container } = render(<DigitalEmployeesPage />)

    expect(
      container.querySelector('[data-warm-digital-employees-list="true"]'),
    ).toBeInTheDocument()
    expect(screen.getByTestId('activity-feed')).toBeInTheDocument()

    const statusGroup = screen.getByRole('group', { name: '状态筛选' })
    expect(within(statusGroup).getByRole('button', { name: /全部 3/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    await user.click(within(statusGroup).getByRole('button', { name: /运行中 1/ }))
    expect(screen.getByRole('button', { name: /报表快递员/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /库存观察员/ })).not.toBeInTheDocument()

    await user.click(within(statusGroup).getByRole('button', { name: /运行中 1/ }))
    const search = screen.getByRole('searchbox', { name: '搜索数字员工' })
    await user.type(search, '库存')
    expect(screen.getByRole('button', { name: /库存观察员/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /报表快递员/ })).not.toBeInTheDocument()
  })

  it('preserves detail navigation, office opening, manual refresh, and header refresh', async () => {
    const user = userEvent.setup()
    render(<DigitalEmployeesPage />)

    await user.click(screen.getByRole('button', { name: /报表快递员/ }))
    expect(mocks.push).toHaveBeenCalledWith('/dashboard/ai/digital-employees/1')

    await user.click(screen.getByRole('button', { name: '全屏展示' }))
    expect(mocks.open).toHaveBeenCalledWith(
      '/dashboard/ai/digital-employees/office',
      '_blank',
    )

    await user.click(screen.getByRole('button', { name: '刷新' }))
    expect(mocks.mutate).toHaveBeenCalled()

    expect(mocks.headerRefresh).not.toBeNull()
    expect(mocks.headerRefreshLoading).toBe(false)
    await act(async () => {
      await mocks.headerRefresh?.()
    })
    expect(mocks.mutate).toHaveBeenCalledTimes(2)
  })
})
