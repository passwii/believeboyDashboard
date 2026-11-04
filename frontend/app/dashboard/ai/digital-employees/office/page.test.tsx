import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { OfficeEmployee } from '@/lib/digital-employee/office-stream-types'

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  searchParams: new URLSearchParams(),
  headerRefresh: null as null | (() => void | Promise<void>),
  headerRefreshLoading: null as null | boolean,
}))

function officeEmployee(
  employeeId: number,
  name: string,
  displayStatus: OfficeEmployee['display_status'],
  busyLevel: OfficeEmployee['busy_level'],
  queuedCount = 0,
): OfficeEmployee {
  return {
    employee_id: employeeId,
    name,
    persona: { emoji: '📊', color_key: 'amber', tagline: '数据观察员' },
    display_status: displayStatus,
    busy_level: busyLevel,
    queued_count: queuedCount,
    pace: 1.2,
    current_task: {
      task_id: `task-${employeeId}`,
      task_name: `任务 ${employeeId}`,
      status: 'RUNNING',
    },
    work_item: { project_name: '项目甲', report_label: '库存日报' },
    virtual_progress: 64,
    step_label: '检查库存',
    today_done: 8,
    success_rate: 0.95,
    last_heartbeat_at: '2026-11-04T12:00:00Z',
  }
}

const EMPLOYEES = [
  officeEmployee(1, '待命员工', 'IDLE', 'IDLE'),
  officeEmployee(2, '满负荷员工', 'WORKING', 'SWAMPED', 7),
  officeEmployee(3, '忙碌员工', 'WORKING', 'BUSY', 3),
  officeEmployee(4, '在岗员工', 'WORKING', 'NORMAL'),
]

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () => mocks.searchParams,
}))

vi.mock('@/lib/digital-employee/use-office-stream', () => ({
  useOfficeStream: () => ({
    employees: EMPLOYEES,
    connected: true,
    chatterFeed: [
      {
        employee_id: 4,
        name: '在岗员工',
        emoji: '📊',
        event_type: 'task_completed',
        text: '完成库存日报',
        timestamp: '2026-11-04T12:00:00Z',
      },
    ],
    refreshing: false,
    refresh: mocks.refresh,
  }),
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

import DigitalOfficePage from './page'

describe('DigitalOfficePage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.searchParams = new URLSearchParams()
    mocks.headerRefresh = null
    document.documentElement.classList.remove('dark')
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      value: null,
    })
  })

  it('renders the Warm normal office and preserves status sorting', async () => {
    const requestFullscreen = vi.fn(async () => undefined)
    Object.defineProperty(document.documentElement, 'requestFullscreen', {
      configurable: true,
      value: requestFullscreen,
    })
    const user = userEvent.setup()
    const { container } = render(<DigitalOfficePage />)

    expect(container.querySelector('[data-warm-digital-office="true"]')).toBeInTheDocument()
    const names = screen
      .getAllByTestId('office-employee')
      .map((element) => element.getAttribute('data-employee-name'))
    expect(names).toEqual(['满负荷员工', '忙碌员工', '在岗员工', '待命员工'])
    expect(screen.getAllByTestId('office-employee')[0]).toHaveAttribute(
      'data-office-card',
      'warm',
    )
    expect(screen.getByText('今日合计完成 32 件')).toBeInTheDocument()
    expect(mocks.headerRefresh).not.toBeNull()
    expect(mocks.headerRefreshLoading).toBe(false)
    await act(async () => {
      await mocks.headerRefresh?.()
    })
    expect(mocks.refresh).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: '投屏' }))
    expect(requestFullscreen).toHaveBeenCalled()
    expect(mocks.push).toHaveBeenCalledWith(
      '/dashboard/ai/digital-employees/office?mode=presentation',
    )
  })

  it('keeps the presentation exception forced-dark and Escape exits fullscreen', async () => {
    mocks.searchParams = new URLSearchParams('mode=presentation')
    const requestFullscreen = vi.fn(async () => undefined)
    const exitFullscreen = vi.fn(async () => undefined)
    Object.defineProperty(document.documentElement, 'requestFullscreen', {
      configurable: true,
      value: requestFullscreen,
    })
    Object.defineProperty(document, 'exitFullscreen', {
      configurable: true,
      value: exitFullscreen,
    })
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      value: document.body,
    })

    const user = userEvent.setup()
    const { container, unmount } = render(<DigitalOfficePage />)

    expect(container.querySelector('[data-office-presentation="true"]')).toBeInTheDocument()
    expect(document.documentElement).toHaveClass('dark')
    expect(screen.getByRole('heading', { name: '虚拟办公室' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'ESC 退出' })).toBeInTheDocument()
    const presentationCard = screen.getByText('满负荷员工').closest('[role="button"]')
    expect(presentationCard).toHaveClass('bg-term-panel')
    expect(presentationCard).not.toHaveAttribute('data-office-card')

    await user.click(screen.getByRole('button', { name: 'ESC 退出' }))
    expect(exitFullscreen).toHaveBeenCalled()
    expect(mocks.push).toHaveBeenCalledWith('/dashboard/ai/digital-employees/office')

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(exitFullscreen).toHaveBeenCalledTimes(2)
    expect(mocks.push).toHaveBeenCalledTimes(2)

    unmount()
    expect(document.documentElement).not.toHaveClass('dark')
  })
})
