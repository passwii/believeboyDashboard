import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

// ── 模块级常量（BLF-450 / BLF-460 实测教训：inline 新引用会让 effect 无限重跑）──
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

// Radix Select 无仓库内交互先例（jsdom 下 portal 交互不稳），
// 桩成本地 select 以测组件接线（onValueChange → query param）
vi.mock('@/components/ui/select', () => {
  const NativeSelect = ({
    value,
    onValueChange,
    children,
  }: {
    value?: string
    onValueChange?: (v: string) => void
    children?: React.ReactNode
  }) => {
    return (
      <select
        data-testid="native-select"
        value={value === 'all' ? '' : value}
        onChange={(e) => onValueChange?.(e.target.value)}
      >
        {children}
      </select>
    )
  }
  return {
    Select: NativeSelect,
    SelectContent: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    SelectItem: ({
      value,
      children,
    }: {
      value?: string
      children?: React.ReactNode
    }) => <option value={value}>{children}</option>,
    SelectTrigger: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    SelectValue: () => null,
  }
})

import { AgentAccessLogsPanel } from './agent-access-logs-panel'

const readRow = {
  id: 1,
  created_at: '2026-08-06T09:00:00Z',
  method: 'GET',
  path: '/api/v1/agent/projects/12/shipments',
  status_code: 200,
  latency_ms: 42,
  ip_address: '1.2.3.4',
  api_key_id: 7,
  agent_id: 'shipment-assistant-prod',
  key_label: '货件助理 (生产)',
  project_id: 12,
  operation_type: 'shipments',
}

const otherRow = {
  ...readRow,
  id: 2,
  path: '/api/v1/agent/projects',
  status_code: 404,
  project_id: null,
  operation_type: null,
  agent_id: null,
  key_label: null,
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('AgentAccessLogsPanel（BLF-460 读操作明细补列）', () => {
  beforeEach(() => {
    const listResponse = {
      items: [readRow, otherRow],
      total: 2,
      page: 1,
      page_size: 50,
      has_next: false,
    }
    const summaryResponse = {
      total: 2,
      success_count: 1,
      error_count: 1,
      unique_agent_count: 1,
      top_agents: [{ agent_id: 'shipment-assistant-prod', key_label: '货件助理 (生产)', count: 1 }],
    }
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/summary')) return Promise.resolve(jsonResponse(summaryResponse))
      return Promise.resolve(jsonResponse(listResponse))
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('展示项目 ID 列与操作类型列（域中文名映射）', async () => {
    render(<AgentAccessLogsPanel />)

    expect(await screen.findByText('项目 ID')).toBeTruthy()
    // 表头 + 筛选下拉占位都有「操作类型」→ 用 getAll
    expect(screen.getAllByText('操作类型').length).toBeGreaterThanOrEqual(1)
    // 有域的行 → 中文标签；无域的行 → '-'
    expect(screen.getAllByText('货件管理').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('-').length).toBeGreaterThanOrEqual(1)
  })

  it('project_id / operation_type 筛选提交到请求参数', async () => {
    render(<AgentAccessLogsPanel />)
    await screen.findByText('项目 ID')

    fireEvent.change(screen.getByPlaceholderText('项目 ID（数字）'), {
      target: { value: '12' },
    })
    // 操作类型下拉（Select 桩成本地 select）：选「货件管理」（AGENT_DOMAINS 的 shipments）
    const selects = screen.getAllByTestId('native-select')
    const operationTypeSelect = selects[selects.length - 1]
    fireEvent.change(operationTypeSelect, { target: { value: 'shipments' } })
    fireEvent.click(screen.getByRole('button', { name: /查询/ }))

    await waitFor(() => {
      const fetchMock = vi.mocked(fetch)
      const urls = fetchMock.mock.calls
        .map((call) => String(call[0]))
        .filter((u) => u.includes('/agent-access-logs?'))
      const latestUrl = urls[urls.length - 1]
      expect(latestUrl).toContain('project_id=12')
      expect(latestUrl).toContain('operation_type=shipments')
    })
  })
})
