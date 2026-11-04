import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DigitalEmployee, DigitalEmployeeTask } from '@/types/digital-employee'

const mocks = vi.hoisted(() => ({
  back: vi.fn(),
  headerRefresh: null as null | (() => void | Promise<void>),
  headerRefreshLoading: null as null | boolean,
}))

const EMPLOYEE: DigitalEmployee = {
  id: 2,
  name: '库存观察员',
  description: '监控库存水位',
  avatar_url: null,
  employee_type: 'MONITORING',
  status: 'IDLE',
  last_heartbeat_at: '2026-11-04T12:00:00Z',
  is_silent_alert_threshold_minutes: 30,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

const TASKS: DigitalEmployeeTask[] = Array.from({ length: 11 }).map((_, index) => ({
  id: index + 1,
  task_id: `task-${index + 1}`,
  task_name: `任务 ${index + 1}`,
  task_type: 'MONITOR',
  status: index === 0 ? 'RUNNING' : 'SUCCEEDED',
  progress_percent: index === 0 ? 42 : 100,
  current_step: index === 0 ? '检查库存' : null,
  started_at: '2026-11-04T11:00:00Z',
  ended_at: index === 0 ? null : '2026-11-04T11:10:00Z',
  error_message: null,
  metadata_json: null,
  created_at: '2026-11-04T11:00:00Z',
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ back: mocks.back }),
  useParams: () => ({ id: '2' }),
}))

vi.mock('@/lib/digital-employee-api', () => ({
  fetchDigitalEmployee: vi.fn(async () => EMPLOYEE),
  fetchEmployeeTasks: vi.fn(async () => ({ items: TASKS, total: TASKS.length })),
  suspendEmployee: vi.fn(async () => undefined),
  resumeEmployee: vi.fn(async () => undefined),
}))

vi.mock('@/components/digital-employee/live-log', () => ({
  LiveLog: () => <div data-testid="live-log" />,
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

import * as api from '@/lib/digital-employee-api'
import EmployeeDetailPage from './page'

function renderPage() {
  return render(<EmployeeDetailPage />)
}

describe('EmployeeDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.headerRefresh = null
  })

  it('renders the Warm task/log ledger and keeps task pagination', async () => {
    const user = userEvent.setup()
    const { container } = renderPage()

    expect(await screen.findByText('库存观察员')).toBeInTheDocument()
    expect(
      container.querySelector('[data-warm-digital-employee-detail="true"]'),
    ).toBeInTheDocument()
    expect(screen.getByTestId('live-log')).toBeInTheDocument()
    expect(screen.getAllByText('任务 1')).toHaveLength(2)
    expect(screen.queryByText('任务 11')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '加载更多' }))
    expect(screen.getByText('任务 11')).toBeInTheDocument()
    expect(api.fetchEmployeeTasks).toHaveBeenCalledWith(2)
  })

  it('preserves pause/resume actions and header refresh', async () => {
    const user = userEvent.setup()
    renderPage()

    expect(await screen.findByText('库存观察员')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '暂停' }))
    expect(api.suspendEmployee).toHaveBeenCalledWith(2)
    expect(await screen.findByRole('button', { name: '恢复' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '恢复' }))
    expect(api.resumeEmployee).toHaveBeenCalledWith(2)
    expect(await screen.findByRole('button', { name: '暂停' })).toBeInTheDocument()

    expect(mocks.headerRefresh).not.toBeNull()
    await act(async () => {
      await mocks.headerRefresh?.()
    })
    expect(api.fetchDigitalEmployee).toHaveBeenCalledTimes(2)
    expect(mocks.headerRefreshLoading).toBe(false)
  })
})
