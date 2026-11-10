import { readFileSync } from 'node:fs'
import { act, render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

// ── mocks ────────────────────────────────────────────────────────────────────

// 稳定引用：避免每次渲染产生新对象导致 loadData identity 抖动、
// useEffect 重复触发（真实 useSession / useNotifications 返回稳定引用）
const { stableSession, mockNotify } = vi.hoisted(() => ({
  stableSession: { user: { id: 'user-1', roleType: 'admin' } },
  mockNotify: vi.fn(),
}))

vi.mock('next-auth/react', () => ({
  useSession: () => ({
    data: stableSession,
    status: 'authenticated' as const,
  }),
}))

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard/operations/return-analysis',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

let mockParams: Record<string, string> = { project: '1', country: 'US', tab: 'rankings' }
vi.mock('@/lib/hooks/use-url-param', () => ({
  useUrlParam: (key: string, initial: string) => [mockParams[key] ?? initial, vi.fn()],
}))

vi.mock('@/lib/hooks/use-auto-select-first-project', () => ({
  useAutoSelectFirstProject: vi.fn(),
}))

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
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

// 捕获 header 刷新回调，供 force 语义断言
let capturedRefreshHandler: (() => void) | null = null
let capturedRefreshLoading: boolean | undefined
vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: (handler: () => void, opts?: { loading?: boolean }) => {
    capturedRefreshHandler = handler
    capturedRefreshLoading = opts?.loading
  },
  useHeaderSlot: (node: React.ReactNode) => null,
  useMobileFilterStrip: () => null,
}))

// exceljs 假实现：捕获 addWorksheet 顺序与每个 sheet 写入的行
const excelCapture = vi.hoisted(() => ({
  sheetNames: [] as string[],
  rowsBySheet: {} as Record<string, unknown[][]>,
  fillsBySheet: {} as Record<string, Array<Array<unknown>>>,
  bordersBySheet: {} as Record<string, Array<Array<unknown>>>,
}))

vi.mock('exceljs', () => {
  class FakeWorksheet {
    name: string
    views: unknown[] = []
    columns: unknown[] = []
    constructor(name: string) {
      this.name = name
    }
    addRow(values: unknown) {
      const cells = Array.isArray(values) ? values : [values]
      const bucket = excelCapture.rowsBySheet[this.name] ?? []
      bucket.push(cells)
      excelCapture.rowsBySheet[this.name] = bucket
      const cell = { font: {}, border: {}, fill: {}, alignment: {} }
      return {
        height: 0,
        font: {},
        eachCell: (cb: (c: typeof cell) => void) => cells.forEach(() => cb(cell)),
      }
    }
    getRow(rowNumber: number) {
      const sheetName = this.name
      const makeCell = (column: number) => ({
        font: {},
        alignment: {},
        set fill(value: unknown) {
          const rows = excelCapture.fillsBySheet[sheetName] ?? []
          rows[rowNumber] ??= []
          rows[rowNumber][column] = value
          excelCapture.fillsBySheet[sheetName] = rows
        },
        get fill() {
          return excelCapture.fillsBySheet[sheetName]?.[rowNumber]?.[column]
        },
        set border(value: unknown) {
          const rows = excelCapture.bordersBySheet[sheetName] ?? []
          rows[rowNumber] ??= []
          rows[rowNumber][column] = value
          excelCapture.bordersBySheet[sheetName] = rows
        },
        get border() {
          return excelCapture.bordersBySheet[sheetName]?.[rowNumber]?.[column]
        },
      })
      return {
        getCell: (column: number) => makeCell(column),
        eachCell: (cb: (cell: ReturnType<typeof makeCell>) => void) => cb(makeCell(1)),
      }
    }
  }
  class FakeWorkbook {
    creator = ''
    created: Date = new Date()
    addWorksheet(name: string) {
      excelCapture.sheetNames.push(name)
      return new FakeWorksheet(name)
    }
    get xlsx() {
      return { writeBuffer: () => Promise.resolve(new ArrayBuffer(8)) }
    }
  }
  return { Workbook: FakeWorkbook, default: { Workbook: FakeWorkbook } }
})

// jsdom 未实现 blob URL 与锚点导航：导出用例只需不抛错
window.URL.createObjectURL = () => 'blob:mock'
window.URL.revokeObjectURL = () => {}
HTMLAnchorElement.prototype.click = () => {}

const SUMMARY = {
  total_returns: 42,
  total_quantity: 58,
  unique_skus: 12,
  top_return_sku: 'SKU-TOP',
  top_return_reason: 'QUALITY_UNACCEPTABLE',
  top_return_reason_display: '质量不合格',
  total_sales_quantity: 500,
  total_sales_amount: 12345,
  overall_return_rate: 8.4,
}

function returnPayload(overrides?: Partial<Record<string, unknown>>) {
  return {
    project_id: 1,
    project_name: '项目A',
    country: 'US',
    start_date: '2026-08-20',
    end_date: '2026-08-26',
    summary: SUMMARY,
    summary_text: '本周退货率偏高。',
    ranking_rows: [
      {
        sku: 'SKU-001',
        asin: 'B0AAAAAAA1',
        product_name: '测试商品一',
        total_quantity: 10,
        return_count: 8,
        sales_quantity: 100,
        return_rate: 10,
        avg_return_cycle_days: 5,
        min_return_cycle_days: 1,
        max_return_cycle_days: 12,
      },
    ],
    reason_rows: [
      {
        reason: 'QUALITY_UNACCEPTABLE',
        reason_display: '质量不合格',
        total_quantity: 20,
        return_count: 15,
        percentage: 35.7,
      },
    ],
    trend_rows: [
      {
        date: '2026-08-20',
        total_quantity: 5,
        return_count: 4,
        sales_quantity: 50,
        sales_amount: 1000,
        return_rate: 8,
      },
    ],
    disposition_rows: [
      {
        detailed_disposition: 'CustomerDamaged',
        disposition_display: '客户损坏',
        total_quantity: 10,
        return_count: 8,
        percentage: 20,
      },
    ],
    status_rows: [
      {
        status: 'UnitReturnedToInventory',
        status_display: '已退回库存',
        total_quantity: 12,
        return_count: 10,
        percentage: 25,
      },
    ],
    feedback_rows: [
      {
        sku: 'SKU-001',
        order_id: 'ORDER-1',
        reason: 'QUALITY_UNACCEPTABLE',
        reason_display: '质量不合格',
        customer_comment: '质量很差',
        return_date: '2026-08-22',
      },
    ],
    weekday_rows: [
      { weekday: 1, weekday_display: '周一', return_count: 5, percentage: 14 },
    ],
    fulfillment_center_rows: [
      { fulfillment_center_id: 'FC-1', return_count: 10, quantity: 12, percentage: 20 },
    ],
    multi_item_return_count: 3,
    multi_item_return_quantity: 7,
    ...overrides,
  }
}

const RAW_ROWS_PAYLOAD = {
  project_id: 1,
  country: 'US',
  start_date: '2026-08-20',
  end_date: '2026-08-26',
  row_count: 1,
  rows: [
    {
      return_date: '2026-08-22',
      original_return_datetime: '2026-08-22T10:00:00+00:00',
      order_id: 'ORDER-RAW-1',
      sku: 'SKU-RAW-1',
      asin: 'B0RAW00001',
      fnsku: 'X00RAW',
      product_name: '原始数据商品',
      quantity: 2,
      fulfillment_center_id: 'PGA1',
      detailed_disposition: 'SELLABLE',
      disposition_display: '可售',
      reason: 'NOT_AS_DESCRIBED',
      reason_display: '与描述不符',
      status: 'Unit returned to inventory',
      status_display: '退回库存',
      license_plate_number: 'LP-RAW-1',
      customer_comment: '原始评论',
    },
  ],
}

function rawRowsPayload(overrides?: Partial<Record<string, unknown>>) {
  // order_id 带请求序号：让「切周期后旧行被替换」可观测（不是追加）
  return {
    ...RAW_ROWS_PAYLOAD,
    rows: [{ ...RAW_ROWS_PAYLOAD.rows[0], order_id: `ORDER-RAW-${rawRequestCount}` }],
    ...overrides,
  }
}

let rawRequestCount = 0
let rawShouldFail = false
let rawRowCountOverride: number | null = null
let rawRowsEmpty = false
// 让下一次 raw-rows 请求挂起（模拟「在途的旧周期请求」）：payload 在发起时就固化，
// 由测试手动放行，用于复现「旧响应回来时覆盖新周期」的竞态。
let rawHoldPending = false
let rawReleasePending: (() => void) | null = null
// 程序化生成超过页内上限的行数（验证 RAW_DISPLAY_LIMIT 截断，而不是只改 row_count）
let rawGeneratedRowCount: number | null = null

let lastForce: boolean | undefined
// 原始行请求单独记录 force：lastForce 会被主分析请求覆盖，无法鉴别预取是否
// 继承了「全局刷新」的粘性旗标（A 项回归用例依赖这个独立的观测点）。
let lastRawForce: boolean | undefined
vi.mock('@/lib/ops-client-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ops-client-cache')>()
  return {
    ...actual,
    fetchOpsJsonCached: vi.fn().mockImplementation((url: string, opts?: { force?: boolean }) => {
      lastForce = opts?.force
      if (url.includes('/return-analysis/raw-rows')) {
        lastRawForce = opts?.force
        rawRequestCount += 1
        if (rawShouldFail) return Promise.reject(new Error('原始数据加载失败'))
        const payload = rawRowsEmpty
          ? { ...rawRowsPayload(), rows: [], row_count: 0 }
          : rawGeneratedRowCount !== null
            ? rawRowsPayload({
                rows: Array.from({ length: rawGeneratedRowCount }, (_, index) => ({
                  ...RAW_ROWS_PAYLOAD.rows[0],
                  order_id: `ORDER-RAW-${index + 1}`,
                })),
                row_count: rawGeneratedRowCount,
              })
            : rawRowCountOverride !== null
              ? rawRowsPayload({ row_count: rawRowCountOverride })
              : rawRowsPayload()
        if (rawHoldPending) {
          rawHoldPending = false
          return new Promise((resolve) => {
            rawReleasePending = () => resolve(payload)
          })
        }
        return Promise.resolve(payload)
      }
      return Promise.resolve(returnPayload())
    }),
  }
})

import ReturnAnalysisClient, {
  RETURN_REASON_COLORS,
  RETURN_REASON_SLICE_STROKE,
  RETURN_REASON_SLICE_STROKE_WIDTH,
} from './return-analysis-client'
import { fetchOpsJsonCached } from '@/lib/ops-client-cache'
import { RAW_DISPLAY_LIMIT, RETURN_RAW_COLUMNS } from './return-raw-columns'

/** 与组件同算法推导默认周期（站点时区下的今天往前 6 天），用于钉住请求里的实际日期 */
function defaultRangeFor(country: 'US' | 'DE' | 'UK') {
  const timeZone = {
    US: 'America/Los_Angeles',
    DE: 'Europe/Berlin',
    UK: 'Europe/London',
  }[country]
  const [year, month, day] = new Intl.DateTimeFormat('en-CA', { timeZone })
    .format(new Date())
    .split('-')
    .map(Number)
  const end = new Date(year!, month! - 1, day!)
  const start = new Date(year!, month! - 1, day!)
  start.setDate(start.getDate() - 6)
  const ymd = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  return { start: ymd(start), end: ymd(end) }
}

// ── tests ────────────────────────────────────────────────────────────────────

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  capturedRefreshHandler = null
  capturedRefreshLoading = undefined
  lastForce = undefined
  lastRawForce = undefined
  rawRequestCount = 0
  rawShouldFail = false
  rawRowCountOverride = null
  rawRowsEmpty = false
  rawHoldPending = false
  rawReleasePending = null
  rawGeneratedRowCount = null
  mockParams = { project: '1', country: 'US', tab: 'rankings' }
  excelCapture.sheetNames.length = 0
  Object.keys(excelCapture.rowsBySheet).forEach((key) => {
    delete excelCapture.rowsBySheet[key]
  })
})

describe('ReturnAnalysisClient header 化渲染契约（BLF-834 / operations header migration）', () => {
  it('渲染不崩溃：SummaryTile 磁贴条与表格行出现', async () => {
    render(<ReturnAnalysisClient />)
    // 磁贴条（data 加载后）
    expect(await screen.findByText('退货单数')).toBeInTheDocument()
    expect(screen.getByText('整体退货率')).toBeInTheDocument()
    expect(screen.getByText('多件退货')).toBeInTheDocument()
    // 表格行（rankings tab 默认）
    expect(await screen.findByText('SKU-001')).toBeInTheDocument()
  })

  it('Warm Ledger 契约：页面根、自身滚动表格与统计磁贴', async () => {
    const { container } = render(<ReturnAnalysisClient />)
    await screen.findByText('SKU-001')

    const page = container.querySelector('[data-warm-page="return-analysis"]')
    expect(page).not.toBeNull()
    expect(container.querySelector('[data-warm-summary="return-analysis"]')).not.toBeNull()

    const scroll = container.querySelector('[data-warm-table-scroll]')
    expect(scroll).not.toBeNull()
    expect(scroll?.querySelector('table')).not.toBeNull()
    expect(scroll?.className).toMatch(/warm/i)
  })

  it('Warm Ledger 契约：图表面板使用 Warm 容器', async () => {
    mockParams = { project: '1', country: 'US', tab: 'reason' }
    const { container } = render(<ReturnAnalysisClient />)
    expect(await screen.findByText('退货原因分析')).toBeInTheDocument()
    expect(container.querySelector('[data-warm-chart="return-reasons"]')).not.toBeNull()
  })

  it('主请求失败时显示独立 error 状态，不退化为 empty，且保留通知', async () => {
    vi.mocked(fetchOpsJsonCached).mockRejectedValueOnce(new Error('退货服务不可用'))
    const { container } = render(<ReturnAnalysisClient />)
    const page = container.querySelector('[data-warm-page="return-analysis"]')

    expect(await screen.findByText('退货数据加载失败')).toHaveAttribute(
      'data-warm-state',
      'error'
    )
    expect(page).toHaveAttribute('data-warm-state', 'error')
    expect(screen.queryByText('暂无退货排行数据')).not.toBeInTheDocument()
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', title: '退货数据加载失败' })
    )
  })

  it('退货原因饼图使用中性分类色 token，不表达 positive/negative 语义', () => {
    expect(RETURN_REASON_COLORS).toEqual([
      'var(--warm-ledger-color-chart-1)',
      'var(--warm-ledger-color-chart-2)',
      'var(--warm-ledger-color-chart-3)',
      'var(--warm-ledger-color-chart-4)',
      'var(--warm-ledger-color-chart-5)',
    ])
    expect(new Set(RETURN_REASON_COLORS).size).toBe(5)

    expect(RETURN_REASON_SLICE_STROKE).toBe('var(--warm-ledger-color-panel)')
    expect(RETURN_REASON_SLICE_STROKE_WIDTH).toBe(2)
  })

  it('商品/库存状态有数据时不再渲染空图表占位，生产源不含占位文案', async () => {
    const source = readFileSync(
      'app/dashboard/operations/return-analysis/return-analysis-client.tsx',
      'utf8'
    )
    expect(source).not.toContain('图表展示区域（可扩展）')

    mockParams = { project: '1', country: 'US', tab: 'product-status' }
    const first = render(<ReturnAnalysisClient />)
    expect(await screen.findByText('客户损坏')).toBeInTheDocument()
    expect(screen.queryByText('图表展示区域（可扩展）')).not.toBeInTheDocument()
    first.unmount()

    mockParams = { project: '1', country: 'US', tab: 'inventory-status' }
    render(<ReturnAnalysisClient />)
    expect(await screen.findByText('已退回库存')).toBeInTheDocument()
    expect(screen.queryByText('图表展示区域（可扩展）')).not.toBeInTheDocument()
  })

  it('Warm Ledger 契约：空态与原始数据错误态带可识别状态标记', async () => {
    vi.mocked(fetchOpsJsonCached).mockResolvedValueOnce(
      returnPayload({ ranking_rows: [] }) as never
    )
    const { container, unmount } = render(<ReturnAnalysisClient />)
    const empty = await screen.findByText('暂无退货排行数据')
    expect(empty).toHaveAttribute('data-warm-state', 'empty')
    expect(container.querySelector('[data-warm-page="return-analysis"]')).toHaveAttribute(
      'data-warm-state',
      'empty'
    )

    unmount()
    rawShouldFail = true
    mockParams = { project: '1', country: 'US', tab: 'raw' }
    render(<ReturnAnalysisClient />)
    expect(await screen.findByText('原始数据加载失败')).toHaveAttribute(
      'data-warm-state',
      'error'
    )
  })

  it('控制台卡片已移除：无「控制台」文案，导出按钮位于工作区卡头', async () => {
    render(<ReturnAnalysisClient />)
    await screen.findByText('SKU-001')
    expect(screen.queryByText('控制台')).not.toBeInTheDocument()
    expect(screen.getByText('退货分析工作区')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /导出 Excel/ })).toBeInTheDocument()
  })

  it('Tab 导航条外置：TabsList 不嵌在工作区卡片内部，且位于卡片之前', async () => {
    const { container } = render(<ReturnAnalysisClient />)
    await screen.findByText('SKU-001')
    const tabList = container.querySelector('[role="tablist"]')
    expect(tabList).not.toBeNull()
    expect(tabList).toContainElement(screen.getByRole('tab', { name: /高退货排行/ }))

    // 定位工作区卡片：从卡头标题向上找到的第一个同时包含表格的祖先（DataTableCard）
    const title = screen.getByText('退货分析工作区')
    const table = container.querySelector('table')
    expect(table).not.toBeNull()
    let card: HTMLElement | null = title
    while (card && !card.contains(table)) card = card.parentElement
    expect(card).not.toBeNull()

    // 外置契约：tab 条不在卡片内部，且整卡位于 tab 条之后（旧结构嵌在卡头内，此断言会失败）
    expect(card).not.toContainElement(tabList as HTMLElement)
    expect(
      (tabList as Node).compareDocumentPosition(card as Node) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('页内重复刷新按钮已移除（全局唯一入口）', async () => {
    render(<ReturnAnalysisClient />)
    await screen.findByText('SKU-001')
    // 旧控制台 RefreshButton 与卡头 ghost「刷新」均已删除，页内不应再有「刷新」按钮
    expect(screen.queryByRole('button', { name: '刷新' })).not.toBeInTheDocument()
  })

  it('整体退货率语义色：>8% 使用 Warm negative', async () => {
    render(<ReturnAnalysisClient />)
    await screen.findByText('整体退货率')
    // 8.4% > 8 → Warm negative
    const rateEl = screen.getByText('8.4%')
    expect(rateEl.className).toMatch(/warm-ledger-color-negative/)
  })

  it('无旧风格残留：面板零圆角、term 边界', async () => {
    const { container } = render(<ReturnAnalysisClient />)
    await screen.findByText('SKU-001')
    // 旧 rounded-lg / rounded-xl 卡片壳已收口为页面本地 Warm 面板
    expect(container.querySelector('.rounded-lg')).toBeNull()
    expect(container.querySelector('.rounded-xl')).toBeNull()
  })

  it('头部刷新回调触发 loadData(force=true)——跳 2min 缓存，且 loading 上报', async () => {
    render(<ReturnAnalysisClient />)
    await screen.findByText('SKU-001')
    expect(capturedRefreshHandler).not.toBeNull()

    // 用受控 Promise 挂起本次重拉，确定性断言 force 语义与 loading 上报
    let resolveFetch: ((value: unknown) => void) | undefined
    vi.mocked(fetchOpsJsonCached).mockImplementationOnce(
      (_url: string, opts?: { force?: boolean }) => {
        lastForce = opts?.force
        return new Promise((resolve) => {
          resolveFetch = resolve
        })
      }
    )

    await act(async () => {
      capturedRefreshHandler?.()
    })
    // loadData(true) 会以 force:true 重拉
    await vi.waitFor(() => expect(lastForce).toBe(true))
    // loading 状态上报给全局刷新按钮
    await vi.waitFor(() => expect(capturedRefreshLoading).toBe(true))

    // 放行请求后 loading 回落
    resolveFetch?.(returnPayload())
    await vi.waitFor(() => expect(capturedRefreshLoading).toBe(false))
  })

  it('刷新进度条位于合法 tbody 行内，table 直接子节点不含裸 div', async () => {
    const { container } = render(<ReturnAnalysisClient />)
    await screen.findByText('SKU-001')

    let resolveFetch: ((value: unknown) => void) | undefined
    vi.mocked(fetchOpsJsonCached).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve
        })
    )

    await act(async () => {
      capturedRefreshHandler?.()
    })

    const progressRow = await screen.findByTestId('refresh-progress-row')
    const table = progressRow.closest('table')
    expect(table).not.toBeNull()
    expect(
      Array.from(table!.children).some((child) => child.tagName.toLowerCase() === 'div')
    ).toBe(false)
    const progressBody = progressRow.parentElement
    expect(progressBody?.tagName).toBe('TBODY')
    expect(progressBody).toHaveAttribute('aria-busy', 'true')
    expect(progressRow.querySelector('td[colspan="10"]')).not.toBeNull()

    const track = progressRow.querySelector('[data-warm-progress]')
    const indicator = screen.getByTestId('refresh-progress-indicator')
    expect(track).toHaveClass('warm-ledger-table-progress-track')
    expect(track).toHaveAttribute('data-warm-tone', 'accent')
    expect(indicator).toHaveClass('warm-ledger-table-progress-bar')
    expect(indicator).toHaveClass('animate-shimmer')

    await act(async () => {
      resolveFetch?.(returnPayload())
    })
    await vi.waitFor(() =>
      expect(progressBody).not.toHaveAttribute('aria-busy', 'true')
    )
  })

  it('首次加载提供 status 与 aria-busy，完成后移除；skeleton 不带动画', async () => {
    let resolveFetch: ((value: unknown) => void) | undefined
    vi.mocked(fetchOpsJsonCached).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve
        })
    )

    const { container } = render(<ReturnAnalysisClient />)
    expect(await screen.findByRole('status')).toHaveTextContent('正在加载退货分析数据')

    const table = container.querySelector('[data-warm-table-scroll] table')
    expect(table).not.toBeNull()
    const busyBody = table?.querySelector('tbody[aria-busy="true"]')
    expect(busyBody).not.toBeNull()
    expect(container.querySelector('[data-warm-skeleton="static"]')).not.toBeNull()
    expect(container.querySelector('.animate-pulse')).toBeNull()

    await act(async () => {
      resolveFetch?.(returnPayload())
    })
    await screen.findByText('SKU-001')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(busyBody).not.toHaveAttribute('aria-busy', 'true')
  })

  it('Raw Tab 懒加载时 raw table aria-busy + status，完成后移除', async () => {
    rawHoldPending = true
    mockParams = { project: '1', country: 'US', tab: 'raw' }
    const { container } = render(<ReturnAnalysisClient />)

    expect(await screen.findByText('正在加载原始退货数据')).toHaveAttribute(
      'role',
      'status'
    )
    await vi.waitFor(() => expect(rawRequestCount).toBe(1))

    const table = container.querySelector('[data-warm-table-scroll] table')
    expect(table).not.toBeNull()
    const busyBody = table?.querySelector('tbody[aria-busy="true"]')
    expect(busyBody).not.toBeNull()
    expect(container.querySelector('[data-warm-skeleton="static"]')).not.toBeNull()
    expect(container.querySelector('.animate-pulse')).toBeNull()

    await act(async () => {
      rawReleasePending?.()
    })
    expect(await screen.findByText('ORDER-RAW-1')).toBeInTheDocument()
    await vi.waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
    expect(busyBody).not.toHaveAttribute('aria-busy', 'true')
  })

  it('空 ranking_rows 时展示空态占位而非崩溃', async () => {
    vi.mocked(fetchOpsJsonCached).mockResolvedValueOnce(
      returnPayload({ ranking_rows: [] }) as never
    )
    render(<ReturnAnalysisClient />)
    // 空态文案来自 EmptyTableState（rankings tab）
    expect(await screen.findByText(/暂无数据|暂无退货排行/)).toBeInTheDocument()
  })

  it('磁贴条展示多件退货子文案「共 N 件」', async () => {
    render(<ReturnAnalysisClient />)
    await screen.findByText('多件退货')
    expect(screen.getByText('共 7 件')).toBeInTheDocument()
  })
})

describe('Top 退货原因磁贴译文来源（BLF-1074 / BLF-1081）', () => {
  /** 取磁贴的数值单元格（SummaryTile 的值 span 带 title，便于区分标签 span） */
  function tileValue(label: string): HTMLElement {
    const tile = screen.getByText(label).closest('div')
    const value = tile?.querySelector('span[title]')
    expect(value).not.toBeNull()
    return value as HTMLElement
  }

  it('直接采用后端 top_return_reason_display（前端不再维护任何本地对照表）', async () => {
    vi.mocked(fetchOpsJsonCached).mockResolvedValueOnce(
      returnPayload({
        summary: {
          ...SUMMARY,
          top_return_reason: 'DAMAGED_BY_FC',
          top_return_reason_display: '仓库致损',
        },
      }) as never
    )
    render(<ReturnAnalysisClient />)
    await screen.findByText('Top 退货原因')

    // 本地对照表已删除（BLF-1081）：译文完全来自后端，绝不裸露英文 code
    await waitFor(() => expect(tileValue('Top 退货原因')).toHaveTextContent('仓库致损'))
    expect(screen.queryByText('DAMAGED_BY_FC')).not.toBeInTheDocument()
  })

  it('以后端译文为唯一来源：与 top_return_reason 可推导的文案不一致时仍取后端', async () => {
    vi.mocked(fetchOpsJsonCached).mockResolvedValueOnce(
      returnPayload({
        summary: {
          ...SUMMARY,
          top_return_reason: 'QUALITY_UNACCEPTABLE',
          top_return_reason_display: '质量有瑕疵',
        },
      }) as never
    )
    render(<ReturnAnalysisClient />)
    await screen.findByText('Top 退货原因')

    // 磁贴不得回退到用 top_return_reason 自行推导文案（单一翻译源，防两份表再次漂移）
    await waitFor(() => expect(tileValue('Top 退货原因')).toHaveTextContent('质量有瑕疵'))
    expect(screen.queryByText('质量不合格')).not.toBeInTheDocument()
  })

  it('无退货原因时展示占位符 --', async () => {
    vi.mocked(fetchOpsJsonCached).mockResolvedValueOnce(
      returnPayload({
        summary: { ...SUMMARY, top_return_reason: null, top_return_reason_display: null },
      }) as never
    )
    render(<ReturnAnalysisClient />)
    await screen.findByText('Top 退货原因')

    await waitFor(() => expect(tileValue('Top 退货原因')).toHaveTextContent('--'))
  })
})

describe('原始数据 Tab（原始行懒加载）', () => {
  it('默认停留在 rankings，不发 raw-rows 请求', async () => {
    render(<ReturnAnalysisClient />)
    await screen.findByText('SKU-001')

    expect(rawRequestCount).toBe(0)
  })

  it('切到原始数据 Tab 才请求一次，且 query 带项目/站点/周期', async () => {
    mockParams = { project: '1', country: 'US', tab: 'raw' }
    render(<ReturnAnalysisClient />)

    expect(await screen.findByText('亚马逊原始数据')).toBeInTheDocument()
    await vi.waitFor(() => expect(rawRequestCount).toBe(1))
    const rawCall = vi
      .mocked(fetchOpsJsonCached)
      .mock.calls.find(([url]) => url.includes('/return-analysis/raw-rows'))
    expect(rawCall?.[0]).toContain('project_id=1')
    expect(rawCall?.[0]).toContain('country=US')
    // 钉住实际周期值（默认周期 = 站点时区今天往前 6 天，与组件同算法推导），
    // 避免 toContain('start_date=') 在空值时也通过
    const expectedRange = defaultRangeFor('US')
    expect(rawCall?.[0]).toContain(`start_date=${expectedRange.start}`)
    expect(rawCall?.[0]).toContain(`end_date=${expectedRange.end}`)
  })

  it('渲染 17 列表头与中文翻译列', async () => {
    mockParams = { project: '1', country: 'US', tab: 'raw' }
    const { container } = render(<ReturnAnalysisClient />)

    expect(await screen.findByText('退货原因（中文）')).toBeInTheDocument()
    expect(screen.getByText('商品状态（中文）')).toBeInTheDocument()
    expect(screen.getByText('库存属性（中文）')).toBeInTheDocument()
    expect(await screen.findByText('ORDER-RAW-1')).toBeInTheDocument()
    expect(screen.getByText('原始数据商品')).toBeInTheDocument()
    // 「17 列」是可数的契约：配置 17 列，实际渲染表头也是 17 个 th
    expect(RETURN_RAW_COLUMNS).toHaveLength(17)
    expect(container.querySelectorAll('thead th')).toHaveLength(RETURN_RAW_COLUMNS.length)
  })

  it('超过页内上限时提示走导出 Excel', async () => {
    rawRowCountOverride = 4321
    mockParams = { project: '1', country: 'US', tab: 'raw' }
    render(<ReturnAnalysisClient />)

    expect(await screen.findByText(/完整 4,321 条请导出 Excel/)).toBeInTheDocument()
  })

  it('超过 RAW_DISPLAY_LIMIT 时页内只渲染上限行数', async () => {
    rawGeneratedRowCount = RAW_DISPLAY_LIMIT + 5
    mockParams = { project: '1', country: 'US', tab: 'raw' }
    const { container } = render(<ReturnAnalysisClient />)

    expect(await screen.findByText('ORDER-RAW-1')).toBeInTheDocument()
    await vi.waitFor(() => {
      expect(container.querySelectorAll('tbody tr').length).toBe(RAW_DISPLAY_LIMIT)
    })
    // 行数上限提示同时出现（完整条数走导出）
    expect(await screen.findByText(/完整 205 条请导出 Excel/)).toBeInTheDocument()
  })

  it('空返回展示空态文案', async () => {
    rawRowsEmpty = true
    mockParams = { project: '1', country: 'US', tab: 'raw' }
    render(<ReturnAnalysisClient />)

    expect(await screen.findByText('所选周期无原始退货数据')).toBeInTheDocument()
  })

  it('主分析请求失败时展示独立错误态，且不触发原始行懒加载', async () => {
    vi.mocked(fetchOpsJsonCached).mockRejectedValueOnce(new Error('退货数据加载失败'))
    mockParams = { project: '1', country: 'US', tab: 'raw' }
    render(<ReturnAnalysisClient />)

    expect(await screen.findByText('退货数据加载失败')).toHaveAttribute(
      'data-warm-state',
      'error'
    )
    // data 为 null 时懒加载不会发原始行请求
    expect(rawRequestCount).toBe(0)
  })

  it('加载失败展示错误与重试按钮，重试会再发一次请求', async () => {
    rawShouldFail = true
    mockParams = { project: '1', country: 'US', tab: 'raw' }
    render(<ReturnAnalysisClient />)

    expect(await screen.findByText('原始数据加载失败')).toBeInTheDocument()
    expect(rawRequestCount).toBe(1)

    rawShouldFail = false
    await userEvent.click(screen.getByRole('button', { name: '重试' }))

    await vi.waitFor(() => expect(rawRequestCount).toBe(2))
  })

  it('切换周期后清空旧周期原始行（防串数据）', async () => {
    mockParams = { project: '1', country: 'US', tab: 'raw' }
    render(<ReturnAnalysisClient />)
    // 首次懒加载拿到 ORDER-RAW-1
    await screen.findByText('ORDER-RAW-1')

    // 触发一次全局刷新：loadData 先清空 rawRows，随后懒加载重取（序号递增）
    await act(async () => {
      capturedRefreshHandler?.()
    })

    // 新 payload 是 ORDER-RAW-2 且旧行消失 —— 证明是「替换」不是「追加」
    expect(await screen.findByText('ORDER-RAW-2')).toBeInTheDocument()
    expect(screen.queryByText('ORDER-RAW-1')).not.toBeInTheDocument()
    await vi.waitFor(() => expect(rawRequestCount).toBe(2))
  })

  it('在途旧周期原始请求返回时不覆盖新周期（请求世代守卫）', async () => {
    rawHoldPending = true
    mockParams = { project: '1', country: 'US', tab: 'raw' }
    render(<ReturnAnalysisClient />)

    // 旧周期请求在途：payload 固化为 ORDER-RAW-1，但尚未返回
    await waitFor(() => expect(rawRequestCount).toBe(1))
    expect(rawReleasePending).not.toBeNull()
    expect(screen.queryByText('ORDER-RAW-1')).not.toBeInTheDocument()

    // 请求在途时切周期（全局刷新 → loadData 清空 rawRows 并作废在途响应）
    await act(async () => {
      capturedRefreshHandler?.()
    })

    // 放行旧请求：其响应必须被整体丢弃
    await act(async () => {
      rawReleasePending?.()
    })

    // 旧周期行绝不进表格（无守卫时旧响应会把 ORDER-RAW-1 写回来）
    expect(screen.queryByText('ORDER-RAW-1')).not.toBeInTheDocument()
    // 懒加载必须为新周期重取（无守卫时 rawRows 已为真，懒加载短路 → 永不重取）
    expect(await screen.findByText('ORDER-RAW-2')).toBeInTheDocument()
    await waitFor(() => expect(rawRequestCount).toBe(2))
  })
})

describe('导出 Excel：亚马逊原始数据 sheet', () => {
  it('未打开过原始数据 Tab 时，导出会先拉原始行并追加第 6 张 sheet', async () => {
    excelCapture.sheetNames = []
    excelCapture.rowsBySheet = {}
    excelCapture.fillsBySheet = {}
    excelCapture.bordersBySheet = {}
    render(<ReturnAnalysisClient />)
    await screen.findByText('SKU-001')
    expect(rawRequestCount).toBe(0)

    await userEvent.click(screen.getByRole('button', { name: /导出 Excel/ }))

    await vi.waitFor(() => expect(rawRequestCount).toBe(1))
    await vi.waitFor(() =>
      expect(excelCapture.sheetNames).toEqual([
        '退货排行',
        '退货原因',
        '商品状态',
        '库存状态',
        '顾客反馈',
        '亚马逊原始数据',
      ])
    )
    const rawSheetRows = excelCapture.rowsBySheet['亚马逊原始数据']
    expect(rawSheetRows).toHaveLength(2) // 表头 + 1 行数据
    expect(rawSheetRows[0]).toHaveLength(17)
    expect(rawSheetRows[0][0]).toBe('退货日期（站点时区）')
    expect(rawSheetRows[1][2]).toBe('ORDER-RAW-1')
    expect(rawSheetRows[1][12]).toBe('与描述不符')
    expect(excelCapture.fillsBySheet['亚马逊原始数据']?.[2]?.[1]).toMatchObject({
      fgColor: { argb: 'FFFFFFFF' },
    })
    expect(excelCapture.bordersBySheet['亚马逊原始数据']?.[2]?.[17]).toMatchObject({
      left: { style: 'thin' },
      right: { style: 'thin' },
    })
  })

  it('原始行拉取失败时中止导出，不产出任何 sheet', async () => {
    excelCapture.sheetNames = []
    excelCapture.rowsBySheet = {}
    excelCapture.fillsBySheet = {}
    excelCapture.bordersBySheet = {}
    rawShouldFail = true
    render(<ReturnAnalysisClient />)
    await screen.findByText('SKU-001')

    await userEvent.click(screen.getByRole('button', { name: /导出 Excel/ }))

    await vi.waitFor(() =>
      expect(mockNotify).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', title: '导出失败' })
      )
    )
    expect(excelCapture.sheetNames).toEqual([])
  })

  it('导出 sheet 携带全部行，不随页内 200 行截断', async () => {
    excelCapture.sheetNames = []
    excelCapture.rowsBySheet = {}
    excelCapture.fillsBySheet = {}
    excelCapture.bordersBySheet = {}
    // 生成超过页内上限的行数，且全程停留 rankings Tab（页内不渲染原始表格，
    // 唯一的截断风险点就是导出自身若误用 RAW_DISPLAY_LIMIT 切片）。
    rawGeneratedRowCount = RAW_DISPLAY_LIMIT + 5
    render(<ReturnAnalysisClient />)
    await screen.findByText('SKU-001')

    await userEvent.click(screen.getByRole('button', { name: /导出 Excel/ }))

    // 1 行表头 + 全部 205 行数据（导出若回归为切片，这里只剩 201 行）
    await vi.waitFor(() =>
      expect(excelCapture.rowsBySheet['亚马逊原始数据']).toHaveLength(
        RAW_DISPLAY_LIMIT + 6
      )
    )
    expect(excelCapture.rowsBySheet['亚马逊原始数据']![1]![2]).toBe('ORDER-RAW-1')
    expect(excelCapture.rowsBySheet['亚马逊原始数据']![RAW_DISPLAY_LIMIT + 5]![2]).toBe(
      `ORDER-RAW-${RAW_DISPLAY_LIMIT + 5}`
    )
  })

  it('原始数据 Tab 未打开时刷新，导出预取仍继承 force 旗标（不吃 2min 缓存）', async () => {
    render(<ReturnAnalysisClient />)
    await screen.findByText('SKU-001')
    expect(rawRequestCount).toBe(0)

    // 全局刷新：原始数据 Tab 关着，rawForceRef 被置 true 且粘性保留（未被消费）
    await act(async () => {
      capturedRefreshHandler?.()
    })
    await vi.waitFor(() => expect(lastForce).toBe(true))
    await vi.waitFor(() => expect(capturedRefreshLoading).toBe(false))
    expect(rawRequestCount).toBe(0)

    await userEvent.click(screen.getByRole('button', { name: /导出 Excel/ }))

    await vi.waitFor(() => expect(rawRequestCount).toBe(1))
    // 预取必须带 force:true —— 否则导出会回落到 2min 客户端缓存里的旧原始行
    expect(lastRawForce).toBe(true)
  })
})
