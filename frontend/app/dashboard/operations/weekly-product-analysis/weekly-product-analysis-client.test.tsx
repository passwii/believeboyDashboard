import { render, screen, cleanup, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── mocks ────────────────────────────────────────────────────────────────────

// 稳定引用：避免每次渲染产生新对象导致 loadProjects / loadData identity 抖动、
// useEffect 重复触发、双重 fetch、loading 断言竞态（真实 useSession / useNotifications
// 返回稳定引用）。关键教训：必须用 vi.hoisted 定义常量再在 factory 里引用。
const { stableSession, mockNotify, fetchMock, mockGetClientCache, mockSetClientCache, downloadBlobMock } = vi.hoisted(
  () => ({
    stableSession: { user: { id: 'user-1', roleType: 'admin' } },
    mockNotify: vi.fn(),
    downloadBlobMock: vi.fn(),
    // 带签名建 mock：mock.calls 得到 [RequestInfo | URL] 元组类型（beforeEach 会覆写实现）
    fetchMock: vi.fn((_input: RequestInfo | URL): Promise<Response> =>
      Promise.resolve({ ok: true, status: 200 } as unknown as Response)
    ),
    mockGetClientCache: vi.fn((_key: string, _maxAgeMs?: number): unknown => null),
    mockSetClientCache: vi.fn(),
  })
)

vi.mock('@/lib/download-blob', () => ({ downloadBlob: downloadBlobMock }))

vi.mock('next-auth/react', () => ({
  useSession: () => ({
    data: stableSession,
    status: 'authenticated' as const,
  }),
}))

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard/operations/weekly-product-analysis',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

let mockParams: Record<string, string> = { project: '1', country: 'US' }
vi.mock('@/lib/hooks/use-url-param', () => ({
  useUrlParam: (key: string, initial: string) => [mockParams[key] ?? initial, vi.fn()],
}))

vi.mock('@/lib/hooks/use-auto-select-first-project', () => ({
  useAutoSelectFirstProject: vi.fn(),
}))

vi.mock('@/lib/hooks/use-mobile', () => ({
  useMobile: () => false,
}))

vi.mock('@/components/notifications', () => ({
  useNotifications: () => ({ notify: mockNotify }),
}))

vi.mock('@/lib/project-client-cache', () => ({
  fetchManagedProjectsCached: vi.fn().mockResolvedValue([
    { id: 1, name: '项目A' },
    { id: 2, name: '项目B' },
  ]),
}))

// 自建客户端缓存置为「永远未命中」：加载路径确定（全量 loading），
// force 语义断言 = 强刷时不再读缓存（本页 force:true 即跳缓存，URL 不带 force 参数）。
vi.mock('@/lib/client-cache', () => ({
  getClientCache: mockGetClientCache,
  setClientCache: mockSetClientCache,
  clearClientCache: vi.fn(),
  clearClientCacheByPrefix: vi.fn(),
}))

// 捕获 header 刷新回调与 loading 上报，供双 tab 分支 / force 语义断言
let capturedRefreshHandler: (() => void) | null = null
let capturedRefreshLoading: boolean | undefined
vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: (handler: () => void, opts?: { loading?: boolean }) => {
    capturedRefreshHandler = handler
    capturedRefreshLoading = opts?.loading
  },
  useHeaderSlot: () => null,
  useMobileFilterStrip: () => null,
}))

// ── fixtures ─────────────────────────────────────────────────────────────────

const WEEKLY_ROWS = [
  {
    id: 11,
    project_id: 1,
    project_name: '项目A',
    country: 'US',
    report_start_date: '2026-08-17',
    report_end_date: '2026-08-23',
    version: 1,
    is_current: true,
    row_count: 7,
    total_sales: 1200,
    total_units: 60,
    total_ad_spend: 240,
    summary_row: { 总销量: 60, 总销售额: 1200, 广告花费: 240, 页面浏览量: 3000 },
  },
  {
    id: 12,
    project_id: 1,
    project_name: '项目A',
    country: 'US',
    report_start_date: '2026-08-10',
    report_end_date: '2026-08-16',
    version: 1,
    is_current: false,
    row_count: 7,
    total_sales: 1000,
    total_units: 50,
    total_ad_spend: 200,
    summary_row: {
      总销量: 50,
      总销售额: 1000,
      广告花费: 200,
      页面浏览量: 2600,
      _is_partial: true,
    },
  },
]

const DETAILS_PAYLOAD = {
  pt1_id: 12,
  report_start_date: '2026-08-10',
  report_end_date: '2026-08-16',
  has_next: false,
  rows: [
    {
      id: 901,
      source_row_no: 1,
      sku: 'SKU-001',
      asin: 'B0AAAAAAA1',
      raw_row: { 日期: '2026-08-10', SKU: 'SKU-001', 总销量: 6, 总销售额: 120, 广告花费: 24 },
    },
  ],
}

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload)),
  } as unknown as Response
}

function defaultFetchRouter(input: RequestInfo | URL): Promise<Response> {
  const url = String(input)
  if (url.includes('/api/v1/product-analysis/pt1/')) {
    return Promise.resolve(jsonResponse(DETAILS_PAYLOAD))
  }
  if (url.includes('/api/v1/product-analysis/inventory/current')) {
    return Promise.resolve(jsonResponse({ rows: [] }))
  }
  if (url.includes('/api/v1/product-analysis/weekly')) {
    return Promise.resolve(jsonResponse(WEEKLY_ROWS))
  }
  return Promise.resolve(jsonResponse({}))
}

function fetchCallsOf(match: string): unknown[][] {
  return fetchMock.mock.calls.filter(([input]) => String(input).includes(match))
}

function cacheGetsOf(keyPrefix: string): unknown[][] {
  return mockGetClientCache.mock.calls.filter(([key]) => String(key).startsWith(keyPrefix))
}

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation(defaultFetchRouter)
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  capturedRefreshHandler = null
  capturedRefreshLoading = undefined
  mockParams = { project: '1', country: 'US' }
})

import WeeklyProductAnalysisClient from './weekly-product-analysis-client'
import { applyDataRowBanding } from '@/lib/excel-styles'

// ── tests ────────────────────────────────────────────────────────────────────

describe('WeeklyProductAnalysisClient header 化渲染契约（operations header migration · Batch A1）', () => {
  it('weekly summary and detail data ranges use alternating fills without touching partial and total rows', () => {
    const cells = Array.from({ length: 8 }, () => Array.from({ length: 4 }, () => ({ fill: undefined as unknown })))
    const worksheet = {
      getRow: (rowNumber: number) => ({ getCell: (column: number) => cells[rowNumber][column] }),
    }
    cells[1][1].fill = { color: 'header' }
    cells[4][1].fill = { color: 'total' }
    cells[5][1].fill = { color: 'note' }

    applyDataRowBanding({ worksheet: worksheet as never, startRow: 2, rowCount: 2, columnCount: 3 })

    expect(cells[1][1].fill).toMatchObject({ color: 'header' })
    expect(cells[2][1].fill).toMatchObject({ fgColor: { argb: 'FFFFFFFF' } })
    expect(cells[3][1].fill).toMatchObject({ fgColor: { argb: 'FFF8FAFC' } })
    expect(cells[4][1].fill).toMatchObject({ color: 'total' })
    expect(cells[5][1].fill).toMatchObject({ color: 'note' })
  })
  it('Excel 汇总与明细：数据行交替底纹、黄色优先、合并与冻结坐标与数值格式不变', async () => {
    downloadBlobMock.mockReset()
    const user = userEvent.setup()
    render(<WeeklyProductAnalysisClient />)
    await screen.findByText('2026-08-17 至 2026-08-23')

    await user.click(screen.getByRole('button', { name: /导出 Excel/ }))
    await vi.waitFor(() => expect(downloadBlobMock).toHaveBeenCalledTimes(1))

    const [blob] = downloadBlobMock.mock.calls[0] as [Blob, string]
    const ExcelJS = await import('exceljs')
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(await blob.arrayBuffer())

    const summary = workbook.getWorksheet('汇总')!
    // 数据行按数据序号交替：首行不完整周黄色优先覆盖斑马白底，第二行落到浅灰蓝
    expect(summary.getCell('C3').fill).toMatchObject({ fgColor: { argb: 'FFFFF3CD' } })
    expect(summary.getCell('C4').fill).toMatchObject({ fgColor: { argb: 'FFF8FAFC' } })
    expect(summary.getCell('C3').value).toBe(50)
    expect(summary.getCell('C4').value).toBe(60)
    // 数值格式不变
    expect(summary.getCell('C3').numFmt).toBe('#,##0')
    expect(summary.getCell('C4').numFmt).toBe('#,##0')
    // 两层表头 / 周次列的合并范围不变
    expect(summary.getCell('A1').master.address).toBe('A1')
    expect(summary.getCell('A2').master.address).toBe('A1')
    expect(summary.getCell('B2').master.address).toBe('B1')
    // 冻结坐标保留 + 隐藏网格线
    expect(summary.views[0]).toMatchObject({
      state: 'frozen',
      ySplit: 2,
      xSplit: 2,
      showGridLines: false,
    })
    // 合计行与说明行仍按原结构写出（rowIndex 冲突为 PR 前既有问题，另开 issue 处理）
    expect(summary.getCell('A5').value).toBe('* 黄色背景标记：该周数据不完整，仅供参考')

    const detail = workbook.getWorksheet('SKU明细')!
    expect(detail.getCell('B3').value).toBe('SKU-001')
    // 首个明细数据行（序号 0）为白色，空值尾列也有细边框
    expect(detail.getCell('C3').fill).toMatchObject({ fgColor: { argb: 'FFFFFFFF' } })
    expect(detail.getCell(3, 41).border).toMatchObject({ top: { style: 'thin' } })
    expect(detail.getCell('A1').master.address).toBe('A1')
    expect(detail.views[0]).toMatchObject({
      state: 'frozen',
      ySplit: 2,
      xSplit: 2,
      showGridLines: false,
    })
    expect(detail.getCell('A4').value).toBe('合计')
  })

  it('渲染不崩溃：周汇总表格、双 tab 与导出/重算入口齐全', async () => {
    render(<WeeklyProductAnalysisClient />)

    // 周汇总行出现（数据加载完成）
    expect(await screen.findByText('2026-08-17 至 2026-08-23')).toBeInTheDocument()
    expect(screen.getByText('2026-08-10 至 2026-08-16')).toBeInTheDocument()

    // 双 tab 切换器与卡头操作（保留项）
    expect(screen.getByRole('button', { name: '周汇总' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'SKU明细' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /导出 Excel/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /重新核算/ })).toBeInTheDocument()

    // 趋势统计条（DataTableCardStatBar 保留项）
    expect(screen.getByText('销售额合计')).toBeInTheDocument()

    // 稳定引用回归护栏：session/notify identity 抖动会导致 effect 重复触发 → 重复拉数
    expect(fetchCallsOf('/api/v1/product-analysis/weekly?')).toHaveLength(1)
  })

  it('旧控制台已移除：无「控制台」文案、无 PageHeader 胶囊、无页内「刷新」按钮', async () => {
    render(<WeeklyProductAnalysisClient />)
    await screen.findByText('2026-08-17 至 2026-08-23')

    // 控制台卡片整体删除（标题由 header 面包屑「按周产品分析」承载）
    expect(screen.queryByText('控制台')).not.toBeInTheDocument()
    // PageHeader 胶囊（标题 + 描述）一并移除
    expect(screen.queryByText('每周商品分析')).not.toBeInTheDocument()
    expect(screen.queryByText(/按周聚合商品销售/)).not.toBeInTheDocument()
    // 控制台 RefreshButton 与明细 tab「刷新 SKU明细」局部按钮均已删除——全局刷新唯一入口
    expect(screen.queryByRole('button', { name: /刷新/ })).not.toBeInTheDocument()
  })

  it('头部刷新（汇总 tab）：force 重拉周汇总数据集——跳客户端缓存并上报 loading', async () => {
    render(<WeeklyProductAnalysisClient />)
    await screen.findByText('2026-08-17 至 2026-08-23')
    expect(capturedRefreshHandler).not.toBeNull()

    const weeklyBefore = fetchCallsOf('/api/v1/product-analysis/weekly?').length
    expect(weeklyBefore).toBe(1)
    const cacheGetsBefore = cacheGetsOf('weekly-analysis:data:').length
    expect(cacheGetsBefore).toBeGreaterThan(0) // 首次加载走过缓存读（useCache=true）

    // 受控 deferred Promise 挂起本次重拉，确定性断言 force 语义与 loading 上报
    let refreshUrl = ''
    let resolveRefresh: ((value: Response) => void) | undefined
    fetchMock.mockImplementationOnce((input: RequestInfo | URL) => {
      refreshUrl = String(input)
      return new Promise<Response>((resolve) => {
        resolveRefresh = resolve
      })
    })

    act(() => {
      void capturedRefreshHandler?.()
    })

    // 重拉命中汇总数据集；force:true ⇒ 不再读客户端缓存（本页 force 语义即跳缓存）
    await vi.waitFor(() =>
      expect(fetchCallsOf('/api/v1/product-analysis/weekly?').length).toBe(weeklyBefore + 1)
    )
    expect(refreshUrl).toContain('/api/v1/product-analysis/weekly?')
    expect(cacheGetsOf('weekly-analysis:data:').length).toBe(cacheGetsBefore)
    // 分支正确性：汇总 tab 刷新不应触碰明细数据集
    expect(fetchCallsOf('/api/v1/product-analysis/pt1/')).toHaveLength(0)
    // loading 状态上报给全局刷新按钮
    await vi.waitFor(() => expect(capturedRefreshLoading).toBe(true))

    // 放行请求后 loading 回落（act 包裹放行点，收敛异步 setState 告警）
    await act(async () => {
      resolveRefresh?.(jsonResponse(WEEKLY_ROWS))
    })
    await vi.waitFor(() => expect(capturedRefreshLoading).toBe(false))
  })

  it('头部刷新（明细 tab）：重拉当前激活 tab 数据集——pt1 明细 force 跳缓存', async () => {
    const user = userEvent.setup()
    render(<WeeklyProductAnalysisClient />)
    await screen.findByText('2026-08-17 至 2026-08-23')

    // 切到 SKU明细 tab：selectedWeekId 已自动落到首周（trendRows 按日期升序，首行 id=12），
    // 触发 loadWeeklyDetails()
    await user.click(screen.getByRole('button', { name: 'SKU明细' }))
    expect(await screen.findByText('SKU-001')).toBeInTheDocument()

    const detailsBefore = fetchCallsOf('/api/v1/product-analysis/pt1/').length
    expect(detailsBefore).toBeGreaterThan(0)
    const cacheGetsBefore = cacheGetsOf('weekly-analysis:details:').length
    expect(cacheGetsBefore).toBeGreaterThan(0) // 首次进 tab 走过缓存读

    // 挂起刷新触发的明细重拉
    let refreshUrl = ''
    let resolveRefresh: ((value: Response) => void) | undefined
    fetchMock.mockImplementationOnce((input: RequestInfo | URL) => {
      refreshUrl = String(input)
      return new Promise<Response>((resolve) => {
        resolveRefresh = resolve
      })
    })

    act(() => {
      void capturedRefreshHandler?.()
    })

    // 刷新走明细分支：重拉当前选中周次的 pt1 明细，且 force:true 跳过缓存读
    await vi.waitFor(() =>
      expect(fetchCallsOf('/api/v1/product-analysis/pt1/').length).toBe(detailsBefore + 1)
    )
    expect(refreshUrl).toContain('/api/v1/product-analysis/pt1/12/details')
    expect(cacheGetsOf('weekly-analysis:details:').length).toBe(cacheGetsBefore)
    // 分支正确性：明细 tab 刷新不应重拉周汇总数据集（挂载时的一次之外无新增）
    expect(fetchCallsOf('/api/v1/product-analysis/weekly?')).toHaveLength(1)
    // 明细 tab 的 detailsLoading 上报给全局刷新按钮
    await vi.waitFor(() => expect(capturedRefreshLoading).toBe(true))

    await act(async () => {
      resolveRefresh?.(jsonResponse(DETAILS_PAYLOAD))
    })
    await vi.waitFor(() => expect(capturedRefreshLoading).toBe(false))
  })
})
