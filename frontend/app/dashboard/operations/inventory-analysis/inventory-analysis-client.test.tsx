import { render, screen, cleanup } from '@testing-library/react'
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
    const negCells = container.querySelectorAll('.text-term-neg')
    const texts = Array.from(negCells).map((el) => el.textContent)
    expect(texts).toContain('缺货')
    expect(texts).toContain('超龄')
    const posCells = container.querySelectorAll('.text-term-pos')
    expect(Array.from(posCells).map((el) => el.textContent)).toContain('有货')
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
