import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { stableNotifications, stableSession } from '@/test-utils/stable-mocks'

// ── mocks（组件 mount 即拉数据，测试只关注渲染契约，拦截全部网络） ─────────────

vi.mock('next-auth/react', () => ({
  useSession: () => stableSession({ user: { id: 'user-1', roleType: 'admin' } }),
}))

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard/operations/inventory-analysis',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

let mockParams: Record<string, string> = { project: '1', country: 'US' }
vi.mock('@/lib/hooks/use-url-param', () => ({
  useUrlParam: (_key: string, initial: string) => [
    mockParams[_key] ?? initial,
    vi.fn(),
  ],
}))

vi.mock('@/components/notifications', () => ({
  useNotifications: () => stableNotifications(),
}))

const { downloadBlobMock } = vi.hoisted(() => ({ downloadBlobMock: vi.fn() }))
vi.mock('@/lib/download-blob', () => ({
  downloadBlob: downloadBlobMock,
}))

vi.mock('@/lib/project-client-cache', () => ({
  fetchManagedProjectsCached: vi.fn().mockResolvedValue([
    { id: 1, name: '项目A' },
    { id: 2, name: '项目B' },
  ]),
}))

vi.mock('@/components/terminal/global-filter-context', () => ({
  useTerminalGlobalFilter: () => ({
    ready: false,
    projectId: '',
    country: '',
    dateFrom: '',
    dateTo: '',
    setProjectId: vi.fn(),
    setCountry: vi.fn(),
    setDateRange: vi.fn(),
  }),
}))

const SUMMARY = {
  sku_count: 120,
  out_of_stock_count: 3,
  aging_sku_count: 10,
  over_aged_sku_count: 2,
  total_available_qty: 4567,
  total_sales_qty_7d: 42,
  total_age_0_90_qty: 3000,
  total_age_91_180_qty: 800,
  total_age_181_270_qty: 400,
  total_age_271_365_qty: 200,
  total_age_365_plus_qty: 167,
  action_type_count: 4,
}

function inventoryPayload(overrides?: Partial<{ items: unknown[]; report_date: string | null }>) {
  return {
    project_id: 1,
    project_name: '项目A',
    country: 'US',
    report_date: overrides?.report_date ?? '2026-08-25T00:00:00Z',
    summary: SUMMARY,
    action_options: [],
    items:
      overrides?.items ??
      [
        {
          project_id: 1,
          project_name: '项目A',
          country: 'US',
          sku: 'SKU-001',
          asin: 'B0AAAAAAA1',
          product_name: '测试商品一',
          available_qty: 100,
          sales_qty_7d: 36,
          age_0_90_qty: 60,
          age_91_180_qty: 20,
          age_181_270_qty: 10,
          age_271_365_qty: 5,
          age_365_plus_qty: 5,
          recommended_action: null,
          recommended_action_label: '补货',
          stock_status: 'in_stock',
          aging_status: 'normal',
          shipment_quantities: {},
        },
        {
          project_id: 1,
          project_name: '项目A',
          country: 'US',
          sku: 'SKU-002',
          asin: null,
          product_name: null,
          available_qty: 0,
          sales_qty_7d: 6,
          age_0_90_qty: 0,
          age_91_180_qty: 0,
          age_181_270_qty: 0,
          age_271_365_qty: 0,
          age_365_plus_qty: 30,
          recommended_action: null,
          recommended_action_label: '清仓',
          stock_status: 'out_of_stock',
          aging_status: 'over_aged',
          shipment_quantities: {},
        },
      ],
    shipment_columns: [],
    shipment_column_totals: {},
    sales_window_start: '2026-08-16',
    sales_window_end: '2026-08-23',
  }
}

vi.mock('@/lib/ops-client-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ops-client-cache')>()
  let lastForce = false
  return {
    ...actual,
    fetchOpsJsonCached: vi.fn().mockImplementation((_url, opts) => {
      lastForce = Boolean(opts?.force)
      return Promise.resolve(inventoryPayload())
    }),
    __getLastForce: () => lastForce,
  }
})

vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: () => ({ setLoading: vi.fn() }),
  useHeaderSlot: (node: React.ReactNode) => null,
  useMobileFilterStrip: () => null,
}))

import InventoryAnalysisClient from './inventory-analysis-client'
import { fetchOpsJsonCached } from '@/lib/ops-client-cache'

// ── tests ────────────────────────────────────────────────────────────────────

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('InventoryAnalysisClient 终端化渲染契约（BLF-834）', () => {
  it('渲染 TermTable 明细行与合计行，数值走千分位等宽格式', async () => {
    render(<InventoryAnalysisClient />)
    await screen.findByText('SKU-001')
    expect(screen.getByText('SKU-002')).toBeInTheDocument()
    // 千分位数值（可售总量 4567 出现在统计条与合计行，用 getAllBy）
    expect(screen.getAllByText('4,567').length).toBeGreaterThan(0)
    expect(screen.getByText('100')).toBeInTheDocument()
    // 合计行
    expect(screen.getByText('合计')).toBeInTheDocument()
  })

  it('状态语义着色：缺货/超龄 neg、有货 pos', async () => {
    const { container } = render(<InventoryAnalysisClient />)
    await screen.findByText('SKU-001')
    const table = screen.getByRole('table', { name: '库存明细' })
    const negStatuses = Array.from(table.querySelectorAll('[data-tone="neg"]')).map(
      (el) => el.textContent
    )
    expect(negStatuses).toEqual(expect.arrayContaining(['缺货', '超龄']))
    const posStatuses = Array.from(table.querySelectorAll('[data-tone="pos"]')).map(
      (el) => el.textContent
    )
    expect(posStatuses).toContain('有货')
    expect(container.querySelector('.text-term-neg')).not.toBeNull()
  })

  it('统计条磁贴齐全且缺货>0 时着 neg 色', async () => {
    render(<InventoryAnalysisClient />)
    await screen.findByText('SKU 总数')
    expect(screen.getByText('可售总量')).toBeInTheDocument()
    expect(screen.getByText('缺货 SKU')).toBeInTheDocument()
    expect(screen.getByText('365+ 库龄')).toBeInTheDocument()
  })

  it('空数据时展示空态占位而非崩溃', async () => {
    vi.mocked(fetchOpsJsonCached).mockResolvedValueOnce(inventoryPayload({ items: [] }))
    render(<InventoryAnalysisClient />)
    await screen.findByText('当前筛选下暂无库存快照数据')
  })

  it('无旧风格残留：无阴影类 / 无 rounded 圆角面板', async () => {
    const { container } = render(<InventoryAnalysisClient />)
    await screen.findByText('SKU-001')
    expect(container.querySelector('.shadow-md, .shadow-lg, .shadow-xl')).toBeNull()
  })
})

describe('InventoryAnalysisClient 7 天销量列', () => {
  it('在库存列左侧渲染 7 天销量列，表头带 T-1~T-8 区间提示', async () => {
    render(<InventoryAnalysisClient />)
    await screen.findByText('SKU-001')
    const table = screen.getByRole('table', { name: '库存明细' })
    const headers = Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent)
    // 销量列必须紧邻库存列左侧
    expect(headers.indexOf('7天销量') + 1).toBe(headers.indexOf('库存'))
    const salesHead = table.querySelector('thead th[title*="T-1 至 T-8"]')
    expect(salesHead).not.toBeNull()
    expect(salesHead?.getAttribute('title')).toContain('2026-08-16 ~ 2026-08-23')
  })

  it('每行展示对应 SKU 的销量，合计行汇总 total_sales_qty_7d', async () => {
    render(<InventoryAnalysisClient />)
    await screen.findByText('SKU-001')
    const table = screen.getByRole('table', { name: '库存明细' })
    const bodyRows = Array.from(table.querySelectorAll('tbody tr'))
    const firstRowCells = Array.from(bodyRows[0].querySelectorAll('td')).map((td) => td.textContent)
    // SKU / ASIN / 品名 / 7天销量 / 库存
    expect(firstRowCells.slice(0, 5)).toEqual(['SKU-001', 'B0AAAAAAA1', '测试商品一', '36', '100'])
    const totalRowCells = Array.from(
      bodyRows[bodyRows.length - 1].querySelectorAll('td')
    ).map((td) => td.textContent)
    expect(totalRowCells.slice(0, 5)).toEqual(['合计', '42', '4,567', '3,000', '800'])
  })

  it('接口缺省 sales_qty_7d 时回落占位符，不出现 undefined / NaN', async () => {
    const payload = inventoryPayload()
    // 模拟旧版后端：items 里没有 sales_qty_7d 字段
    const items = (payload.items as Array<Record<string, unknown>>).map((item) => {
      const { sales_qty_7d: _omit, ...rest } = item
      return rest
    })
    vi.mocked(fetchOpsJsonCached).mockResolvedValueOnce({
      ...payload,
      items,
      summary: { ...payload.summary, total_sales_qty_7d: undefined },
      sales_window_start: null,
      sales_window_end: null,
    })
    render(<InventoryAnalysisClient />)
    await screen.findByText('SKU-001')
    const table = screen.getByRole('table', { name: '库存明细' })
    const headers = Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent)
    expect(headers).toContain('7天销量')
    expect(table.textContent).not.toContain('undefined')
    expect(table.textContent).not.toContain('NaN')
  })
})

describe('InventoryAnalysisClient Excel 导出', () => {
  it('导出表把 7 天销量放在库存左侧，并在合计行带上销量合计', async () => {
    downloadBlobMock.mockReset()
    render(<InventoryAnalysisClient />)
    await screen.findByText('SKU-001')
    fireEvent.click(screen.getByRole('button', { name: /导出 Excel/ }))
    await vi.waitFor(() => expect(downloadBlobMock).toHaveBeenCalled())

    const blob = downloadBlobMock.mock.calls[0][0] as Blob
    const ExcelJS = await import('exceljs')
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(await blob.arrayBuffer())
    const sheet = workbook.getWorksheet('库存分析')
    expect(sheet).toBeDefined()
    const headerRow = sheet!.getRow(1)
    const headers: string[] = []
    headerRow.eachCell({ includeEmpty: true }, (cell) => headers.push(String(cell.value)))
    const salesColumn = headers.findIndex((header) => header.startsWith('7天销量')) + 1
    expect(salesColumn).toBeGreaterThan(0)
    expect(headers[salesColumn]).toBe('库存')

    // 表头 1 行 + 2 行明细，合计行在第 4 行
    const totalRow = sheet!.getRow(4)
    expect(totalRow.getCell(salesColumn).value).toBe(42)
    expect(totalRow.getCell(salesColumn + 1).value).toBe(4567)
  })
})
