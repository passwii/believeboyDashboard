import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  notify as stableNotify,
  stableNotifications,
  stableSession,
} from '@/test-utils/stable-mocks'

const { confirmMock } = vi.hoisted(() => ({
  confirmMock: vi.fn(),
}))

vi.mock('next-auth/react', () => ({
  useSession: () => stableSession({ user: { name: 'tester' } }),
}))

vi.mock('@/components/notifications', () => ({
  useNotifications: () => stableNotifications(),
}))

vi.mock('@/hooks/use-confirm', () => ({
  useConfirm: () => ({ confirm: confirmMock }),
}))

vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: () => ({ setLoading: vi.fn() }),
}))

import SystemDataManagementPage from './page'

const summary = {
  total_tables: 12,
  total_rows: 34567,
  stale_tables: 1,
  data_status: 'active',
}

const statusPayload = {
  server_time: '2026-11-04T12:00:00Z',
  database: {
    engine: 'postgresql',
    source: 'BLF',
    healthy: true,
    checked_at: '2026-11-04T11:59:00Z',
  },
  cache_enabled: true,
  summary,
  data_status_note: null,
  data_status_updated_at: '2026-11-04T10:00:00Z',
  data_status_updated_by: 'admin',
}

const overviewPayload = {
  ...statusPayload,
  tables: [
    {
      table_name: 'orders',
      table_name_cn: '订单',
      row_count: 42,
      last_updated_at: '2026-11-04T11:30:00Z',
      status: 'healthy',
      note: null,
    },
  ],
  recent_statuses: [],
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function createFetchMock() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/data-management/status')) return jsonResponse(statusPayload)
    if (url.endsWith('/data-management/overview')) return jsonResponse(overviewPayload)
    if (url.endsWith('/cache/clear-all') && init?.method === 'POST') {
      return jsonResponse({ deleted_count: 8, message: '缓存已清理' })
    }
    return jsonResponse({ detail: `Unexpected request: ${url}` }, 500)
  })
}

describe('SystemDataManagementPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    confirmMock.mockResolvedValue(true)
  })

  it('renders the existing status and overview contract in the Warm page shell', async () => {
    const fetchMock = createFetchMock()
    vi.stubGlobal('fetch', fetchMock)

    const { container } = render(<SystemDataManagementPage />)

    expect(container.querySelector('[data-warm-data-management="true"]')).toBeInTheDocument()
    expect(await screen.findByText('orders')).toBeInTheDocument()
    expect(screen.getByText('订单')).toBeInTheDocument()
    expect(screen.getByText('42')).toBeInTheDocument()
    expect(screen.getByText('34,567')).toBeInTheDocument()
    expect(await screen.findByText('异常/陈旧 1')).toBeInTheDocument()

    const requestedUrls = fetchMock.mock.calls.map(([input]) => String(input))
    expect(requestedUrls).toContain(
      '/api/backend/api/v1/system-management/data-management/status',
    )
    expect(requestedUrls).toContain(
      '/api/backend/api/v1/system-management/data-management/overview',
    )
  })

  it('preserves the destructive confirmation and cache-clear API contract', async () => {
    const fetchMock = createFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<SystemDataManagementPage />)
    await screen.findByText('异常/陈旧 1')

    const clearButton = screen.getByRole('button', { name: '清理缓存' })
    await waitFor(() => expect(clearButton).toBeEnabled())
    await user.click(clearButton)

    expect(confirmMock).toHaveBeenCalledWith({
      title: '确定要清理所有 Redis 缓存吗？',
      variant: 'destructive',
    })
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/backend/api/v1/system-management/cache/clear-all',
        expect.objectContaining({ method: 'POST' }),
      )
    })
    expect(stableNotify).toHaveBeenCalledWith({ type: 'success', title: '缓存已清理' })
  })
})
