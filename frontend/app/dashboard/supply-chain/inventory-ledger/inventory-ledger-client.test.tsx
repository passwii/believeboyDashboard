/**
 * Page-level render test for the redesigned inventory-ledger page
 * (BLF-428 前端重构：全局筛选条 + 总览 + Summary/Detail 双 Tab).
 *
 * Mock 稳定性教训（BLF-450 dashboard v2 实测）：mock 的项目列表等必须用
 * 模块级常量，避免每次 render 新引用触发 effect 无限重跑、loading 振荡。
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
  usePathname: () => '/dashboard/supply-chain/inventory-ledger',
  useRouter: () => ({ replace: nav.replace, push: nav.replace }),
}))

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { name: '测试用户' } }, status: 'authenticated' }),
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

beforeEach(() => {
  nav.setParams('project_id=1&month=2026-03-01')
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const hit = Object.keys(PAYLOADS).find((k) => url.includes(k))
      const body = hit ? PAYLOADS[hit] : {}
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) })
    }),
  )
})

// ── 测试 ──────────────────────────────────────────────────────────────────────

describe('库存分类账页面（重构版）', () => {
  it('渲染标题、全局筛选条与三个 tab', async () => {
    render(<InventoryLedgerPage />)
    expect(screen.getByText('库存分类账')).toBeInTheDocument()
    // 全局筛选条
    expect(screen.getByText('全部 SKU')).toBeInTheDocument()
    expect(screen.getByText('全部仓库')).toBeInTheDocument()
    expect(screen.getByText('全部状态')).toBeInTheDocument()
    expect(screen.getByText('全部事件类型')).toBeInTheDocument()
    // Tabs
    expect(await screen.findByText('汇总视图 Summary')).toBeInTheDocument()
    expect(screen.getByText('明细视图 Detail')).toBeInTheDocument()
    expect(screen.getByText('上传批次')).toBeInTheDocument()
  })

  it('总览区（懒加载 stub）随数据渲染', async () => {
    render(<InventoryLedgerPage />)
    expect(await screen.findByTestId('ledger-overview-stub')).toBeInTheDocument()
  })

  it('汇总视图展示每日水位行', async () => {
    render(<InventoryLedgerPage />)
    // 默认 tab = summary：两行水位（03-01 / 03-02）
    expect(await screen.findByText('每日水位明细')).toBeInTheDocument()
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
})
