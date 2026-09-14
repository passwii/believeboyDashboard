import { render, screen, cleanup } from '@testing-library/react'
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

const SUMMARY = {
  total_returns: 42,
  total_quantity: 58,
  unique_skus: 12,
  top_return_sku: 'SKU-TOP',
  top_return_reason: 'QUALITY_UNACCEPTABLE',
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

let lastForce: boolean | undefined
vi.mock('@/lib/ops-client-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ops-client-cache')>()
  return {
    ...actual,
    fetchOpsJsonCached: vi.fn().mockImplementation((url: string, opts?: { force?: boolean }) => {
      lastForce = opts?.force
      if (url.includes('/return-analysis/raw-rows')) {
        rawRequestCount += 1
        if (rawShouldFail) return Promise.reject(new Error('原始数据加载失败'))
        if (rawRowsEmpty) {
          return Promise.resolve({ ...rawRowsPayload(), rows: [], row_count: 0 })
        }
        if (rawRowCountOverride !== null) {
          return Promise.resolve(rawRowsPayload({ row_count: rawRowCountOverride }))
        }
        return Promise.resolve(rawRowsPayload())
      }
      return Promise.resolve(returnPayload())
    }),
  }
})

import ReturnAnalysisClient from './return-analysis-client'
import { fetchOpsJsonCached } from '@/lib/ops-client-cache'

// ── tests ────────────────────────────────────────────────────────────────────

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  capturedRefreshHandler = null
  capturedRefreshLoading = undefined
  lastForce = undefined
  rawRequestCount = 0
  rawShouldFail = false
  rawRowCountOverride = null
  rawRowsEmpty = false
  mockParams = { project: '1', country: 'US', tab: 'rankings' }
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
    expect(card).not.toContainElement(tabList)
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

  it('整体退货率语义色：>8% 走 term-neg', async () => {
    render(<ReturnAnalysisClient />)
    await screen.findByText('整体退货率')
    // 8.4% > 8 → term-neg
    const rateEl = screen.getByText('8.4%')
    expect(rateEl.className).toMatch(/term-neg/)
  })

  it('无旧风格残留：面板零圆角、term 边界', async () => {
    const { container } = render(<ReturnAnalysisClient />)
    await screen.findByText('SKU-001')
    // 旧 rounded-lg / rounded-xl 卡片壳已收口为 rounded-none + term 边界
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

    capturedRefreshHandler?.()
    // loadData(true) 会以 force:true 重拉
    await vi.waitFor(() => expect(lastForce).toBe(true))
    // loading 状态上报给全局刷新按钮
    await vi.waitFor(() => expect(capturedRefreshLoading).toBe(true))

    // 放行请求后 loading 回落
    resolveFetch?.(returnPayload())
    await vi.waitFor(() => expect(capturedRefreshLoading).toBe(false))
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
    expect(rawCall?.[0]).toContain('start_date=')
    expect(rawCall?.[0]).toContain('end_date=')
  })

  it('渲染 17 列表头与中文翻译列', async () => {
    mockParams = { project: '1', country: 'US', tab: 'raw' }
    render(<ReturnAnalysisClient />)

    expect(await screen.findByText('退货原因（中文）')).toBeInTheDocument()
    expect(screen.getByText('商品状态（中文）')).toBeInTheDocument()
    expect(screen.getByText('库存属性（中文）')).toBeInTheDocument()
    expect(await screen.findByText('ORDER-RAW-1')).toBeInTheDocument()
    expect(screen.getByText('原始数据商品')).toBeInTheDocument()
  })

  it('超过页内上限时提示走导出 Excel', async () => {
    rawRowCountOverride = 4321
    mockParams = { project: '1', country: 'US', tab: 'raw' }
    render(<ReturnAnalysisClient />)

    expect(await screen.findByText(/完整 4,321 条请导出 Excel/)).toBeInTheDocument()
  })

  it('空返回展示空态文案', async () => {
    rawRowsEmpty = true
    mockParams = { project: '1', country: 'US', tab: 'raw' }
    render(<ReturnAnalysisClient />)

    expect(await screen.findByText('所选周期无原始退货数据')).toBeInTheDocument()
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
    capturedRefreshHandler?.()

    // 新 payload 是 ORDER-RAW-2 且旧行消失 —— 证明是「替换」不是「追加」
    expect(await screen.findByText('ORDER-RAW-2')).toBeInTheDocument()
    expect(screen.queryByText('ORDER-RAW-1')).not.toBeInTheDocument()
    await vi.waitFor(() => expect(rawRequestCount).toBe(2))
  })
})
