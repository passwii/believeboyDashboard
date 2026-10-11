import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

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
  project_name: '测试项目',
  operation_type: 'shipments',
  country: 'US',
}

const otherRow = {
  ...readRow,
  id: 2,
  path: '/api/v1/agent/projects',
  status_code: 404,
  project_id: null,
  project_name: null,
  operation_type: null,
  agent_id: null,
  key_label: null,
  country: null,
}

const detailRow = {
  ...readRow,
  id: 3,
  path: '/api/v1/agent/projects/12/shipments/SH-1',
}

const auditRow = {
  ...readRow,
  id: 4,
  path: '/api/v1/agent/projects/12/shipments/SH-1/audit',
}

const inspectionSubmitRow = {
  ...readRow,
  id: 5,
  method: 'POST',
  path: '/api/v1/agent/platform-inspection/periods/3/projects/12/submit',
  operation_type: 'platform_inspection',
}

const monthlyReportRow = {
  ...readRow,
  id: 6,
  path: '/api/v1/agent/monthly-reports/financial-series',
  operation_type: 'monthly_reports',
  agent_id: 'monthly-report-assistant',
  key_label: '月报助理',
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
      items: [readRow, otherRow, detailRow, auditRow, inspectionSubmitRow, monthlyReportRow],
      total: 6,
      page: 1,
      page_size: 50,
      has_next: false,
    }
    const summaryResponse = {
      total: 2,
      success_count: 1,
      error_count: 1,
      unique_agent_count: 1,
      top_agents: [
        {
          agent_id: 'shipment-assistant-prod',
          key_label: '货件助理 (生产)',
          count: 1,
        },
      ],
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

  it('展示项目列与操作列（BLF-471 follow-up：Agent 中文名即 key_label，仅用项目名）', async () => {
    render(<AgentAccessLogsPanel />)

    expect(await screen.findByText('项目')).toBeTruthy()
    expect(screen.getByText('操作')).toBeTruthy()
    // 有域的行 → 中文标签；无域的行 → '—'
    expect(screen.getAllByText('货件管理').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1)
    // 中文名即「名称」（key_label）
    expect(screen.getAllByText('货件助理 (生产)').length).toBeGreaterThanOrEqual(1)
    // 项目仅用名称（无 (id) 后缀）
    expect(screen.getAllByText('测试项目').length).toBeGreaterThanOrEqual(1)
  })

  // ── BLF-845 精细化三件套 ──────────────────────────────────────

  it('BLF-845 ②：概览重设计为 KPI 磁贴 + TOP AGENTS 排行条', async () => {
    render(<AgentAccessLogsPanel />)

    // KPI 磁贴行（含新增的成功率）
    expect(await screen.findByText('请求总量')).toBeTruthy()
    expect(screen.getByText('成功 2XX')).toBeTruthy()
    expect(screen.getByText('失败 ≥4XX')).toBeTruthy()
    expect(screen.getByText('成功率')).toBeTruthy()
    expect(screen.getByText('活跃 AGENT')).toBeTruthy()
    // 成功率 = round(1/2*100) = 50%
    expect(screen.getByText('50%')).toBeTruthy()
    // TOP AGENTS 排行条（title = 「主标识 · N 次」）
    expect(screen.getByText('TOP AGENTS（当前筛选范围）')).toBeTruthy()
    expect(screen.getByTitle('货件助理 (生产) · 1 次')).toBeTruthy()
  })

  it('BLF-845 ③：国家列渲染（迁移 259 后端已透出 country；NULL 显 —）', async () => {
    render(<AgentAccessLogsPanel />)

    // 表头有「国家」列；mock 数据含一条 country='US' 的行 + 一条 NULL 行
    expect(await screen.findByText('国家')).toBeTruthy()
    expect(screen.getAllByText('US').length).toBeGreaterThanOrEqual(1)
    const dashes = screen.getAllByText('—')
    expect(dashes.length).toBeGreaterThanOrEqual(1)
  })

  it('project_id / operation_type 筛选提交到请求参数', async () => {
    render(<AgentAccessLogsPanel />)
    await screen.findByText('项目')

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

  it('月报访问日志显示中文域名并可按 monthly_reports 筛选（BLF-1314）', async () => {
    render(<AgentAccessLogsPanel />)

    const row = await screen.findByRole('row', { name: /财务月报/ })
    expect(within(row).getByText('财务月报')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '财务月报' })).toHaveValue('monthly_reports')
    const selects = screen.getAllByTestId('native-select')
    fireEvent.change(selects[selects.length - 1], { target: { value: 'monthly_reports' } })
    fireEvent.click(screen.getByRole('button', { name: /查询/ }))

    await waitFor(() => {
      const urls = vi.mocked(fetch).mock.calls
        .map((call) => String(call[0]))
        .filter((url) => url.includes('/agent-access-logs?'))
      expect(urls[urls.length - 1]).toContain('operation_type=monthly_reports')
    })
  })

  it('按具体方法与路径显示读写业务动作，而不是只显示业务域', async () => {
    render(<AgentAccessLogsPanel />)

    expect(await screen.findByText('查询货件列表')).toBeTruthy()
    expect(screen.getByText('查询货件详情')).toBeTruthy()
    expect(screen.getByText('查询货件审计')).toBeTruthy()
    expect(screen.getByText('提交平台巡检')).toBeTruthy()
    expect(screen.getByTitle(/POST \/api\/v1\/agent\/platform-inspection/)).toBeTruthy()
  })
})
