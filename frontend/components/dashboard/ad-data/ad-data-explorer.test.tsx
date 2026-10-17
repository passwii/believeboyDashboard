import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AdDataExplorer } from '@/components/dashboard/ad-data/ad-data-explorer'
import { requestAdClientRefresh } from '@/components/dashboard/ad-refresh'
import { clearAdClientCaches } from '@/lib/ad-client-cache'

// ── mocks ────────────────────────────────────────────────────────────────────

let mockSearchParams = new URLSearchParams('projectId=1&country=US')
vi.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
  usePathname: () => '/dashboard/advertising/ad-data',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}))

let mockSession: unknown = {
  user: { id: 'user-1', roleType: 'admin', operatorNameZh: '张三' },
}
let mockStatus = 'authenticated'
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: mockSession, status: mockStatus }),
}))

const UPLOAD_FILES = [{ report_type: 'ad_campaign_report', ingestion_status: 'success' }]

const RAW_ROWS = [
  {
    id: 1,
    campaign_type: 'sp',
    status: 'ENABLED',
    budget: '100',
    impressions: 1000,
    clicks: 50,
    ctr: '0.05',
    spend: '25.30',
    cpc: '0.51',
    orders_7d: 5,
    sales_7d: '300.00',
    acos: '0.084',
    roas: '11.86',
  },
]

const RAW_PAYLOAD = { data: RAW_ROWS, summary: { total_rows: 1 } }

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function mockFetchSequence(fetchMock: ReturnType<typeof vi.spyOn>) {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('ad-upload-files')) return jsonResponse(UPLOAD_FILES)
    if (url.includes('-raw')) return jsonResponse(RAW_PAYLOAD)
    return jsonResponse({})
  })
}

/** 等到数据表渲染且 loading 骨架清空 */
async function waitForTable() {
  await waitFor(
    () => {
      expect(document.querySelector('table')).toBeTruthy()
      expect(document.querySelector('.u-skeleton-shimmer')).toBeNull()
    },
    { timeout: 5000 }
  )
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('AdDataExplorer 终端化渲染契约（BLF-834）', () => {
  beforeEach(() => {
    clearAdClientCaches()
    window.sessionStorage.clear()
    mockSearchParams = new URLSearchParams('projectId=1&country=US')
    mockStatus = 'authenticated'
    vi.restoreAllMocks()
  })

  afterEach(() => {
    cleanup()
    clearAdClientCaches()
    window.sessionStorage.clear()
  })

  it('渲染 TermTable 数据行，数值列右对齐等宽', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    mockFetchSequence(fetchMock)

    render(<AdDataExplorer />)
    await waitForTable()

    // 数值列单元格带 numeric 右对齐类（TermCell numeric → text-right）
    const table = screen.getByRole('table')
    const numericCells = Array.from(table.querySelectorAll('td.text-right'))
    expect(numericCells.length).toBeGreaterThan(0)
    expect(numericCells.some((el) => el.textContent === '1,000')).toBe(true)
  })

  it('控制条含报表类型 / 搜索 / 视图切换 / 导出，无旧 Card 胶囊残留', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    mockFetchSequence(fetchMock)

    const { container } = render(<AdDataExplorer />)
    await waitForTable()

    expect(screen.getByText('报表类型')).toBeInTheDocument()
    expect(screen.getByText('原始明细')).toBeInTheDocument()
    expect(screen.getByText('聚合')).toBeInTheDocument()
    expect(screen.getByText('导出 CSV')).toBeInTheDocument()
    // 无 dashboard-surface 旧面板类
    expect(container.querySelector('.dashboard-surface')).toBeNull()
    // 无阴影残留
    expect(container.querySelector('.shadow-md, .shadow-lg, .shadow-xl')).toBeNull()
  })

  it('点击表头切换排序不崩溃且视图切换可用', async () => {
    const user = userEvent.setup()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    mockFetchSequence(fetchMock)

    render(<AdDataExplorer />)
    await waitForTable()

    await user.click(screen.getByText('点击量'))
    await user.click(screen.getByText('聚合'))
    expect(screen.getByRole('table')).toBeInTheDocument()
  })

  it('广告强刷期间失败保留已加载行、导出可用并显示错误', async () => {
    let rawRequests = 0
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('ad-upload-files')) return jsonResponse(UPLOAD_FILES)
      if (url.includes('-raw')) {
        rawRequests += 1
        if (rawRequests === 1) return jsonResponse(RAW_PAYLOAD)
        throw new Error('刷新连接失败')
      }
      return jsonResponse({})
    })

    render(<AdDataExplorer />)
    await waitForTable()
    expect(screen.getByText('ENABLED')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '导出 CSV' })).toBeEnabled()

    requestAdClientRefresh()

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('刷新连接失败'))
    expect(screen.getByText('ENABLED')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '导出 CSV' })).toBeEnabled()
    expect(screen.queryByText('正在刷新广告明细…')).not.toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalled()
  })

  it('展开行显示 raw_row 原始数据 pre 块', async () => {
    const user = userEvent.setup()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    mockFetchSequence(fetchMock)

    render(<AdDataExplorer />)
    await waitForTable()

    await user.click(screen.getByLabelText('展开原始数据'))
    expect(screen.getByText(/raw_row/)).toBeInTheDocument()
  })
})
