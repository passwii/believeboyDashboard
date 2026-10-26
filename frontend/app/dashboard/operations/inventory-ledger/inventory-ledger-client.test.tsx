/**
 * Page-level tests for the inventory-ledger page
 * (BLF-428 前端重构 + operations 全域 header 化迁移 §3 A4).
 *
 * Header 化契约：
 *  1. 筛选控件（项目/月份 + SKU/仓库/状态/事件类型 4 维派生筛选 + 清除筛选）
 *     portal 进 Top Header 中段插槽；
 *  2. 全局刷新 = 重拉整月聚合数据（本页无缓存），{ loading } 上报；
 *  3. 旧 TermPanel 控制台壳与页内「刷新」按钮已移除（全局唯一入口）。
 *
 * Mock 稳定性教训（必须遵守）：useSession 等 mock 必须返回稳定引用——
 * 用 vi.hoisted 定义常量再在 factory 里引用，否则 identity 抖动导致
 * useEffect 重复触发、双重 fetch、loading 断言竞态。
 * 断言 loading 上报时用受控 deferred Promise 挂起 fetch。
 */

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── next/navigation：进程内 URL search param 存储 ────────────────────────────
const nav = vi.hoisted(() => {
  let params = new URLSearchParams('project_id=1&month=2026-03-01')
  return {
    setParams(qs: string) {
      params = new URLSearchParams(qs)
    },
    get: (key: string) => params.get(key),
    toString: () => params.toString(),
    replace: (url: string) => {
      const qs = url.includes('?') ? (url.split('?')[1] ?? '') : ''
      params = new URLSearchParams(qs)
    },
  }
})

vi.mock('next/navigation', () => ({
  useSearchParams: () => ({ get: nav.get, toString: nav.toString }),
  usePathname: () => '/dashboard/operations/inventory-ledger',
  useRouter: () => ({ replace: nav.replace, push: nav.replace }),
}))

// 稳定引用：避免每次渲染新对象导致 projects effect identity 抖动、重复触发
const { stableSession } = vi.hoisted(() => ({
  stableSession: { user: { name: '测试用户' } },
}))
const { exportLedgerAnalysisToExcelMock } = vi.hoisted(() => ({
  exportLedgerAnalysisToExcelMock: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: stableSession, status: 'authenticated' as const }),
}))

vi.mock('./ledger-excel-export', () => ({
  exportLedgerAnalysisToExcel: exportLedgerAnalysisToExcelMock,
}))

// 模块级常量：避免 fetchManagedProjectsCached 每次返回新数组引用
const PROJECTS = [{ id: 1, name: '项目A' }]

vi.mock('@/lib/project-client-cache', () => ({
  fetchManagedProjectsCached: () => Promise.resolve(PROJECTS),
}))

// 总览区走 next/dynamic + recharts；jsdom 下用 stub 替身
vi.mock('next/dynamic', () => ({
  default: () =>
    function LazyOverviewStub() {
      return <div data-testid="ledger-overview-stub" />
    },
}))

// 测试环境一律按桌面端渲染（与 vitest.setup 的 matchMedia 桩语义一致）
vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}))

// 捕获 header 刷新回调与 loading 上报；插槽内容直接渲染回页面正文，
// 便于断言上移后的筛选控件（生产环境它们被 portal 进 TerminalHeader 中段）。
let capturedRefreshHandler: (() => void | Promise<void>) | null = null
let capturedRefreshLoading: boolean | undefined
vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: (handler: () => void | Promise<void>, opts?: { loading?: boolean }) => {
    capturedRefreshHandler = handler
    capturedRefreshLoading = opts?.loading
    return { setLoading: vi.fn() }
  },
  useHeaderSlot: (node: React.ReactNode) => node,
  useMobileFilterStrip: () => null,
}))

import InventoryLedgerPage from './inventory-ledger-client'

// ── 数据构造 ──────────────────────────────────────────────────────────────────

const SUMMARY_ROWS = [
  {
    id: 1,
    date: '2026-03-02',
    fnsku: 'FN-A',
    asin: 'B-A',
    msku: 'SKU-A',
    title: 'Item A',
    disposition: 'SELLABLE',
    location: 'LAX1',
    starting_balance: 45,
    in_transit_between: 0,
    receipts: 0,
    customer_shipments: -5,
    customer_returns: 0,
    vendor_returns: 0,
    warehouse_transfer_io: 0,
    found: 0,
    lost: 0,
    damaged: 0,
    disposed: 0,
    other_events: 0,
    ending_balance: 40,
    unknown_events: 0,
    store: null,
    batch_id: 1,
  },
  {
    id: 2,
    date: '2026-03-01',
    fnsku: 'FN-A',
    asin: 'B-A',
    msku: 'SKU-A',
    title: 'Item A',
    disposition: 'SELLABLE',
    location: 'LAX1',
    starting_balance: 50,
    in_transit_between: 0,
    receipts: 0,
    customer_shipments: -5,
    customer_returns: 0,
    vendor_returns: 0,
    warehouse_transfer_io: 0,
    found: 0,
    lost: 0,
    damaged: 0,
    disposed: 0,
    other_events: 0,
    ending_balance: 45,
    unknown_events: 0,
    store: null,
    batch_id: 1,
  },
]

const DETAIL_ROWS = [
  {
    id: 101,
    date: '2026-03-02',
    fnsku: 'FN-A',
    asin: 'B-A',
    msku: 'SKU-A',
    title: 'Item A',
    event_type: 'Receipts',
    reference_id: 'FBA123',
    quantity: 9,
    fulfillment_center: 'LAX1',
    disposition: 'SELLABLE',
    reason: null,
    country: 'US',
    reconciled_quantity: null,
    unreconciled_quantity: null,
    date_and_time: null,
    store: null,
    batch_id: 1,
  },
  {
    id: 102,
    date: '2026-03-02',
    fnsku: 'FN-A',
    asin: 'B-A',
    msku: 'SKU-A',
    title: 'Item A',
    event_type: 'Shipments',
    reference_id: null,
    quantity: -1,
    fulfillment_center: 'LAX1',
    disposition: 'SELLABLE',
    reason: null,
    country: 'US',
    reconciled_quantity: null,
    unreconciled_quantity: null,
    date_and_time: null,
    store: null,
    batch_id: 1,
  },
]

const PAYLOADS: Record<string, unknown> = {
  '/inventory-ledger/months': { months: ['2026-03-01'] },
  '/inventory-ledger/snapshot': {
    report_month: '2026-03-01',
    sku_count: 1,
    total_qty: 40,
    disposition_summary: [{ disposition: 'SELLABLE', qty_eom: 40, pct_of_total: 100 }],
    skus: [
      {
        msku: 'SKU-A',
        title: 'Item A',
        qty_eom: 40,
        sellable_qty: 40,
        damaged_qty: 0,
        prev_qty_eom: 50,
        change: -10,
      },
    ],
    integrity: {
      report_month: '2026-03-01',
      status: 'OK',
      mismatch_count: 0,
      mismatches: [],
      checked_at: '2026-03-31T00:00:00Z',
    },
  },
  '/inventory-ledger/trend': {
    project_id: 1,
    months: [
      {
        report_month: '2026-02',
        sku_count: 1,
        total_qty_eom: 50,
        total_receipts: 0,
        total_shipments: 0,
        total_returns: 0,
        total_damaged: 0,
        total_lost: 0,
        total_disposed: 0,
        damaged_pct: 0,
      },
      {
        report_month: '2026-03',
        sku_count: 1,
        total_qty_eom: 40,
        total_receipts: 9,
        total_shipments: 1,
        total_returns: 0,
        total_damaged: 0,
        total_lost: 0,
        total_disposed: 0,
        damaged_pct: 0,
      },
    ],
  },
  '/inventory-ledger/summary': { report_month: '2026-03-01', rows: SUMMARY_ROWS },
  '/inventory-ledger/detail': { report_month: '2026-03-01', rows: DETAIL_ROWS },
  '/inventory-ledger/batches': {
    project_id: 1,
    batches: [
      {
        id: 1,
        project_id: 1,
        report_month: '2026-03-01',
        source_filename: '库存分类账 2026-0301-0331.csv',
        file_hash: 'abc',
        file_size_bytes: 100,
        file_kind: 'summary',
        loaded_by: null,
        loaded_at: '2026-04-01T10:00:00Z',
        completed_at: '2026-04-01T10:00:05Z',
        status: 'success',
        rows_parsed: 2,
        rows_written_summary: 2,
        rows_written_detail: 0,
        rows_skipped_duplicate: 0,
        rows_failed_validation: 0,
        error_message: null,
        consistency_check: 'ok',
        consistency_mismatch_count: 0,
      },
    ],
  },
  '/inventory-ledger/consistency': {
    report_month: '2026-03-01',
    status: 'OK',
    mismatch_count: 0,
    mismatches: [],
    checked_at: '2026-03-31T00:00:00Z',
  },
}

PAYLOADS['/inventory-ledger/month-analysis'] = {
  project_id: 1,
  project_name: '项目A',
  country: 'US',
  report_month: '2026-03-01',
  start_date: '2026-03-01',
  end_date: '2026-03-31',
  generated_at: '2026-04-01T10:00:05Z',
  summary_rows: SUMMARY_ROWS,
  detail_rows: DETAIL_ROWS,
  snapshot: PAYLOADS['/inventory-ledger/snapshot'],
  trend: PAYLOADS['/inventory-ledger/trend'],
  consistency: PAYLOADS['/inventory-ledger/consistency'],
  batches: (PAYLOADS['/inventory-ledger/batches'] as { batches: unknown[] }).batches,
}

const DATA_ENDPOINTS = ['month-analysis']

function okJson(body: unknown) {
  return { ok: true, json: () => Promise.resolve(body) }
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  nav.setParams('project_id=1&month=2026-03-01')
  exportLedgerAnalysisToExcelMock.mockClear()
  fetchMock = vi.fn((url: string) => {
    const hit = Object.keys(PAYLOADS).find((k) => url.includes(k))
    return Promise.resolve(okJson(hit ? PAYLOADS[hit] : {}))
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  capturedRefreshHandler = null
  capturedRefreshLoading = undefined
})

/** 统计某 inventory-ledger 端点被 fetch 的次数 */
const callsFor = (endpoint: string): number =>
  fetchMock.mock.calls.filter((args) =>
    String(args[0]).includes(`/inventory-ledger/${endpoint}`)
  ).length

// ── 测试 ──────────────────────────────────────────────────────────────────────

describe('库存分类账页面（header 化迁移版）', () => {
  it('渲染不崩溃：插槽筛选控件与三个 tab 出现', async () => {
    render(<InventoryLedgerPage />)
    // 等待数据加载完成（tabs 在 hasAnyData 时渲染）
    expect(await screen.findByText('汇总视图 Summary')).toBeInTheDocument()
    expect(screen.getByText('明细视图 Detail')).toBeInTheDocument()
    expect(screen.getByText('上传批次')).toBeInTheDocument()
    // 上移进 header 插槽的控件（测试 mock 将插槽内容渲染回页面正文）
    expect(screen.getByText('项目A')).toBeInTheDocument()
    expect(screen.getByText('2026 年 3 月')).toBeInTheDocument()
    expect(screen.getAllByText('2026-03-01').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('全部 SKU')).toBeInTheDocument()
    expect(screen.getByText('全部仓库')).toBeInTheDocument()
    expect(screen.getByText('全部状态')).toBeInTheDocument()
    expect(screen.getByText('全部事件类型')).toBeInTheDocument()
  })

  it('总览区（懒加载 stub）随数据渲染', async () => {
    render(<InventoryLedgerPage />)
    expect(await screen.findByTestId('ledger-overview-stub')).toBeInTheDocument()
  })

  it('汇总视图展示每日水位行', async () => {
    render(<InventoryLedgerPage />)
    // 默认 tab = summary：两行水位（03-01 / 03-02）
    expect(await screen.findByText('月度水位明细')).toBeInTheDocument()
    expect(screen.getByText('SKU 月度汇总')).toBeInTheDocument()
    expect(screen.getAllByText('SKU-A').length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText('LAX1').length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText('可售').length).toBeGreaterThanOrEqual(2)
  })

  it('切到明细视图后展示事件行（中文事件标签）', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<InventoryLedgerPage />)
    await user.click(await screen.findByRole('tab', { name: '明细视图 Detail' }))
    // setActiveTab 写 URL（mock router.replace）；生产下导航触发重渲染，
    // 测试里用 rerender 让 useUrlParam 重读 URL（与 display-client 测试同款）。
    rerender(<InventoryLedgerPage />)
    expect(await screen.findByText('事件明细')).toBeInTheDocument()
    expect(screen.getByText('每日事件汇总')).toBeInTheDocument()
    expect(screen.getByText('入库')).toBeInTheDocument()
    expect(screen.getByText('出库')).toBeInTheDocument()
    // 净数量摘要条：9 + (-1) = +8
    expect(screen.getByText(/净数量 \+8/)).toBeInTheDocument()
  })

  it('切到上传批次展示批次留档', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<InventoryLedgerPage />)
    await user.click(await screen.findByRole('tab', { name: '上传批次' }))
    rerender(<InventoryLedgerPage />)
    expect(await screen.findByText('库存分类账 2026-0301-0331.csv')).toBeInTheDocument()
    expect(screen.getByText('成功')).toBeInTheDocument()
  })

  it('头部刷新回调重拉整月聚合数据（无缓存），且 loading 上报', async () => {
    render(<InventoryLedgerPage />)
    await screen.findByText('汇总视图 Summary')

    // 初始加载：页面只请求整月聚合数据一次
    for (const name of DATA_ENDPOINTS) {
      expect(callsFor(name)).toBe(1)
    }
    expect(capturedRefreshHandler).not.toBeNull()

    // 用受控 deferred Promise 挂起本次重拉，确定性断言 loading 上报
    const pendingResolvers: Array<(value: ReturnType<typeof okJson>) => void> = []
    fetchMock.mockImplementation(
      (_url: string) =>
        new Promise<ReturnType<typeof okJson>>((resolve) => {
          pendingResolvers.push(resolve)
        })
    )

    act(() => {
      void capturedRefreshHandler?.()
    })

    // loading 状态上报给全局刷新按钮
    await waitFor(() => expect(capturedRefreshLoading).toBe(true))
    // 整月聚合重新拉取（月份列表不在刷新范围，不重取）
    await waitFor(() => expect(pendingResolvers.length).toBe(1))
    for (const name of DATA_ENDPOINTS) {
      expect(callsFor(name)).toBe(2)
    }

    // 放行请求：allSettled 落定后 loading 回落
    for (const resolve of pendingResolvers) {
      resolve(okJson({}))
    }
    await waitFor(() => expect(capturedRefreshLoading).toBe(false))
  })

  it('不再分别请求旧的六个数据端点', async () => {
    render(<InventoryLedgerPage />)
    await screen.findByText('汇总视图 Summary')

    for (const endpoint of ['snapshot', 'trend', 'summary', 'detail', 'batches', 'consistency']) {
      expect(callsFor(endpoint)).toBe(0)
    }
    expect(callsFor('month-analysis')).toBe(1)
  })

  it('移除两个 CSV 按钮并统一导出整月 Excel', async () => {
    const user = userEvent.setup()
    render(<InventoryLedgerPage />)
    await screen.findByText('汇总视图 Summary')

    expect(screen.queryByRole('button', { name: /导出 CSV/ })).not.toBeInTheDocument()
    const exportButton = await screen.findByRole('button', {
      name: /导出库存分析 Excel/,
    })
    await user.click(exportButton)

    expect(exportLedgerAnalysisToExcelMock).toHaveBeenCalledTimes(1)
    expect(exportLedgerAnalysisToExcelMock.mock.calls[0][0]).toMatchObject({
      report_month: '2026-03-01',
      project_name: '项目A',
    })
  })

  it('旧控制台已移除：无「控制台」文案、无页内「刷新」按钮', async () => {
    render(<InventoryLedgerPage />)
    await screen.findByText('汇总视图 Summary')
    expect(screen.queryByText('控制台')).not.toBeInTheDocument()
    // 原 TermPanel 控制台壳（含说明文案）已整体删除，标题由 header 面包屑承载
    expect(screen.queryByText(/按月对账 Amazon Inventory Ledger/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '刷新' })).not.toBeInTheDocument()
  })

  it('清除筛选按钮：有激活筛选时出现，点击后重置筛选', async () => {
    // 深链带 msku 筛选（首次挂载不重置，保住深链分享）
    nav.setParams('project_id=1&month=2026-03-01&msku=SKU-A')
    const user = userEvent.setup()
    const { rerender } = render(<InventoryLedgerPage />)
    const clearBtn = await screen.findByRole('button', { name: /清除筛选/ })
    expect(clearBtn).toHaveTextContent('清除筛选（1）')

    await user.click(clearBtn)
    // setFilters 走 router.replace（mock 写进程内 URL）；rerender 让 useUrlParams 重读
    rerender(<InventoryLedgerPage />)
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /清除筛选/ })).not.toBeInTheDocument()
    )
  })
})
