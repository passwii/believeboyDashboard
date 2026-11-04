import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { notify, session } = vi.hoisted(() => ({
  notify: vi.fn(),
  session: { data: { user: { isAdmin: true } }, status: 'authenticated' },
}))

vi.mock('next-auth/react', () => ({
  useSession: () => session,
}))
vi.mock('@/components/notifications', () => ({
  useNotifications: () => ({ notify }),
}))
vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: () => ({ setLoading: vi.fn() }),
}))
vi.mock('@/components/system/agent-access-logs-panel', () => ({
  AgentAccessLogsPanel: () => <div data-testid="access-logs-panel" />,
}))

import SystemOperationLogsPage from './page'

const auditRow = {
  id: 41,
  created_at: '2026-11-04T09:00:00Z',
  operator: '纪亚伟',
  action: 'projects.update',
  target_type: 'project',
  target_id: '12',
  result: 'success',
  trace_id: 'trace-41',
  request_method: 'PATCH',
  request_path: '/api/v1/projects/12',
  ip_address: '10.0.0.8',
  user_agent: 'Vitest',
  before_json: { name: '旧项目名' },
  after_json: { name: '新项目名' },
  error_message: null,
}

const loginRow = {
  ...auditRow,
  id: 42,
  action: 'auth.login.success',
  target_type: 'user_account',
  target_id: 'admin-1',
  trace_id: 'trace-42',
  request_method: 'POST',
  request_path: '/api/v1/auth/login',
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function listPayload(items: unknown[], total = items.length) {
  return { items, total, page: 1, page_size: 20, has_next: false }
}

function summaryPayload() {
  return {
    total: 1,
    success_count: 1,
    failure_count: 0,
    unique_operator_count: 1,
    modules: [],
    top_actions: [],
  }
}

describe('System logs Warm Ledger migration contracts', () => {
  beforeEach(() => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/summary')) return Promise.resolve(jsonResponse(summaryPayload()))
      if (url.includes('action=auth.')) return Promise.resolve(jsonResponse(listPayload([loginRow])))
      return Promise.resolve(jsonResponse(listPayload([auditRow])))
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('renders Warm Ledger page while preserving audit request and tab navigation', async () => {
    const { container } = render(<SystemOperationLogsPage />)

    expect(await screen.findByRole('columnheader', { name: '时间' })).toBeInTheDocument()
    expect(container.querySelector('[data-warm-page="system-logs"]')).toBeTruthy()
    expect(container.querySelector('[class*="term-"]')).toBeNull()
    expect(screen.getByRole('tab', { name: '操作审计日志' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '登录日志' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Agent 访问日志' })).toBeInTheDocument()

    await waitFor(() => {
      const urls = vi.mocked(fetch).mock.calls.map((call) => String(call[0]))
      expect(
        urls.some(
          (url) =>
            url.includes('/api/v1/system-management/audit-logs?') &&
            url.includes('page_size=20')
        )
      ).toBe(true)
    })
  })

  it('keeps login and Agent tab behavior intact', async () => {
    const user = userEvent.setup()
    render(<SystemOperationLogsPage />)

    await screen.findByRole('columnheader', { name: '时间' })
    await user.click(screen.getByRole('tab', { name: '登录日志' }))
    expect(await screen.findByRole('columnheader', { name: '登录时间' })).toBeInTheDocument()

    await waitFor(() => {
      const urls = vi.mocked(fetch).mock.calls.map((call) => String(call[0]))
      expect(
        urls.some(
          (url) =>
            url.includes('/api/v1/system-management/audit-logs?') &&
            url.includes('action=auth.')
        )
      ).toBe(true)
    })

    await user.click(screen.getByRole('tab', { name: 'Agent 访问日志' }))
    expect(screen.getByTestId('access-logs-panel')).toBeInTheDocument()
  })

  it('keeps the audit other-category behavior unchanged instead of sending action=other', async () => {
    render(<SystemOperationLogsPage />)
    await screen.findByRole('columnheader', { name: '时间' })

    fireEvent.change(screen.getByLabelText('日志分类'), { target: { value: 'other' } })
    fireEvent.click(screen.getByRole('button', { name: '查询' }))

    await waitFor(() => {
      const urls = vi
        .mocked(fetch)
        .mock.calls.map((call) => String(call[0]))
        .filter((url) => url.includes('/api/v1/system-management/audit-logs?'))
      const latestAuditUrl = urls[urls.length - 1]
      expect(latestAuditUrl).not.toContain('action=other')
    })
  })

  it('opens the existing audit detail dialog from a record row', async () => {
    render(<SystemOperationLogsPage />)

    const row = await screen.findByRole('row', { name: /更新项目/ })
    fireEvent.click(row.querySelector('button')!)

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Trace ID: trace-41')).toBeInTheDocument()
    expect(screen.getByText(/新项目名/)).toBeInTheDocument()
  })
})
