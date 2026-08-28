import { render, screen, cleanup, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// ── mocks ────────────────────────────────────────────────────────────────────

// 稳定引用：避免每次渲染产生新对象导致 session/notify identity 抖动、
// useEffect 重复触发、双重 fetch、loading 断言竞态
// （真实 useSession / useNotifications 返回稳定引用）
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
  usePathname: () => '/dashboard/operations/seasonal-replenishment',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

let mockParams: Record<string, string> = { project: '1', country: 'US' }
vi.mock('@/lib/hooks/use-url-param', () => ({
  useUrlParam: (key: string, initial: string, _opts?: unknown) => [
    mockParams[key] ?? initial,
    vi.fn(),
  ],
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

// 捕获 header 刷新回调 / loading 上报 / 插槽节点，供 force 语义与上移断言
let capturedRefreshHandler: (() => void) | null = null
let capturedRefreshLoading: boolean | undefined
let capturedSlotNode: ReactNode = null
vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: (handler: () => void, opts?: { loading?: boolean }) => {
    capturedRefreshHandler = handler
    capturedRefreshLoading = opts?.loading
    return { setLoading: vi.fn() }
  },
  useHeaderSlot: (node: ReactNode) => {
    capturedSlotNode = node
    return null
  },
}))

const SUMMARY = {
  sku_count: 1,
  out_of_stock_risk_count: 0,
  healthy_count: 1,
  slow_moving_count: 0,
  pending_data_count: 0,
  total_available_inventory: 100,
  total_in_transit_quantity: 50,
}

function seasonalPayload(overrides?: Partial<Record<string, unknown>>) {
  return {
    items: [
      {
        project_id: 1,
        project_name: '项目A',
        sku: 'SKU-001',
        country: 'US',
        asin: 'B0AAAAAAA1',
        product_name: '测试商品一',
        available_inventory: 100,
        in_transit_quantity: 50,
        dms_90: 1.1,
        dms_30: 1.2,
        dms_14: 1.3,
        dms_7: 1.4,
        dms_90_yoy: null,
        dms_30_yoy: null,
        dms_14_yoy: null,
        dms_7_yoy: null,
        base_dms: 1.2,
        weighted_dms: 1.18,
        sellable_days: 84,
        sellout_date: '2026-11-19',
        sellout_date_with_transit: '2027-01-05',
        production_lead_days: 30,
        shipping_days: 45,
        estimated_replenishment_quantity: 200,
      },
    ],
    summary: SUMMARY,
    page: 1,
    page_size: 200,
    total: 1,
    has_next: false,
    from_date: '2026-05-30',
    to_date: '2026-08-27',
    compare_year_offset: 0,
    ...overrides,
  }
}

let lastForce: boolean | undefined
vi.mock('@/lib/ops-client-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ops-client-cache')>()
  return {
    ...actual,
    fetchOpsJsonCached: vi.fn().mockImplementation((_url: string, opts?: { force?: boolean }) => {
      lastForce = opts?.force
      return Promise.resolve(seasonalPayload())
    }),
  }
})

import SeasonalReplenishmentClient from './seasonal-replenishment-client'
import { fetchOpsJsonCached } from '@/lib/ops-client-cache'

// ── tests ────────────────────────────────────────────────────────────────────

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  capturedRefreshHandler = null
  capturedRefreshLoading = undefined
  capturedSlotNode = null
  lastForce = undefined
  mockParams = { project: '1', country: 'US' }
})

describe('SeasonalReplenishmentClient header 化渲染契约（operations header migration A3）', () => {
  it('渲染不崩溃：5 格统计条、主表行、权重 Badge 与口径说明出现', async () => {
    render(<SeasonalReplenishmentClient />)
    // 5 格统计条（data 加载后）
    expect(await screen.findByText('SKU 总数')).toBeInTheDocument()
    expect(screen.getByText('总店铺库存')).toBeInTheDocument()
    expect(screen.getByText('总在途库存')).toBeInTheDocument()
    expect(screen.getByText('有销量 SKU')).toBeInTheDocument()
    expect(screen.getByText('待补数据')).toBeInTheDocument()
    // 主表行（桌面表格 + 手机卡片列表各一份，jsdom 不应用 CSS 隐藏）
    expect((await screen.findAllByText('SKU-001')).length).toBeGreaterThan(0)
    // 权重 Badge 与口径说明保留
    expect(
      screen.getByText('权重 90D×40% + 30D×30% + 14D×20% + 7D×10%')
    ).toBeInTheDocument()
    expect(screen.getByText('口径说明')).toBeInTheDocument()
  })

  it('5 个筛选控件注册进头部插槽（portal 节点非空）', async () => {
    render(<SeasonalReplenishmentClient />)
    await screen.findAllByText('SKU-001')
    expect(capturedSlotNode).not.toBeNull()
  })

  it('旧控制台已移除：无「控制台」文案、无「刷新重算」按钮，正文不再渲染筛选控件', async () => {
    render(<SeasonalReplenishmentClient />)
    await screen.findAllByText('SKU-001')
    expect(screen.queryByText('季节性补货控制台')).not.toBeInTheDocument()
    expect(screen.queryByText('控制台')).not.toBeInTheDocument()
    expect(screen.queryByText('季节性补货分析')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /刷新重算/ })).not.toBeInTheDocument()
    // 关键词输入与「去年」开关已上移 header 插槽（mock 插槽不渲染），正文不应出现
    expect(screen.queryByPlaceholderText('搜索 SKU / ASIN')).not.toBeInTheDocument()
    expect(screen.queryByText('去年')).not.toBeInTheDocument()
    // 导出保留（移至主表标题行）
    expect(screen.getByRole('button', { name: /导出 Excel/ })).toBeInTheDocument()
  })

  it('头部刷新回调触发「刷新重算」语义——force:true 重载且 loading 上报', async () => {
    render(<SeasonalReplenishmentClient />)
    await screen.findAllByText('SKU-001')
    expect(capturedRefreshHandler).not.toBeNull()

    // 用受控 Promise 挂起本次重载，确定性断言 force 语义与 loading 上报
    let resolveFetch: ((value: unknown) => void) | undefined
    vi.mocked(fetchOpsJsonCached).mockImplementationOnce(
      (_url: string, opts?: { force?: boolean }) => {
        lastForce = opts?.force
        return new Promise((resolve) => {
          resolveFetch = resolve
        })
      }
    )

    act(() => {
      capturedRefreshHandler?.()
    })
    // forceNextLoadRef=true + refreshNonce+1 → 下一次加载以 force:true 跳缓存重拉
    await vi.waitFor(() => expect(lastForce).toBe(true))
    // loading 状态上报给全局刷新按钮
    await vi.waitFor(() => expect(capturedRefreshLoading).toBe(true))

    // 放行请求后 loading 回落
    resolveFetch?.(seasonalPayload())
    await vi.waitFor(() => expect(capturedRefreshLoading).toBe(false))
  })
})
