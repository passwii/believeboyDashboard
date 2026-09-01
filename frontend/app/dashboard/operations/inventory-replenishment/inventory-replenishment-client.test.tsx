/**
 * Page-level tests for the inventory-replenishment page header 化
 * （operations header migration B1）.
 *
 * 契约：
 * 1. 渲染不崩溃（指挥带 / 3 tabs / 导出 / 快照入口 / 口径说明保留）；
 * 2. 4 个筛选控件（项目/关键词/站点/风险状态）portal 进 header 中段插槽，正文不再渲染；
 * 3. 非快照模式：头部刷新回调 = refreshWithSave（先持久化未保存行编辑，再 force 重载）；
 * 4. 快照模式：头部刷新回调降级为不带 save 的 force 重载（断言保存未发生）；
 * 5. 旧控制台与页内「刷新重算」按钮已移除（全局刷新唯一入口）。
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── next/navigation：进程内 URL search param 存储 ────────────────────────────
const nav = vi.hoisted(() => {
  let params = new URLSearchParams('project=1&country=US')
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

// 关键教训：useSession / useNotifications 的 mock 必须返回稳定引用——
// 用 vi.hoisted 定义常量再在 factory 里引用，否则 identity 抖动导致
// useEffect 重复触发、双重 fetch、loading 断言竞态。
const { stableSession, mockNotify } = vi.hoisted(() => ({
  stableSession: { user: { name: '测试用户' } },
  mockNotify: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useSearchParams: () => ({ get: nav.get, toString: nav.toString }),
  usePathname: () => '/dashboard/operations/inventory-replenishment',
  useRouter: () => ({ replace: nav.replace, push: nav.replace }),
}))

vi.mock('next-auth/react', () => ({
  useSession: () => ({
    data: stableSession,
    status: 'authenticated' as const,
  }),
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

// 模块级常量：避免每次 render 新引用触发 effect 无限重跑、loading 振荡
const PROJECTS = [{ id: 1, name: '项目A' }]

vi.mock('@/lib/project-client-cache', () => ({
  fetchManagedProjectsCached: () => Promise.resolve(PROJECTS),
}))

// 捕获 header 刷新回调 / loading 上报 / 插槽节点，供双模式语义与上移断言
const headerCapture = vi.hoisted(() => ({
  refreshHandler: null as (() => void) | null,
  refreshLoading: undefined as boolean | undefined,
  slotNode: null as ReactNode,
}))
vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: (handler: () => void, opts?: { loading?: boolean }) => {
    headerCapture.refreshHandler = handler
    headerCapture.refreshLoading = opts?.loading
    return { setLoading: vi.fn() }
  },
  useHeaderSlot: (node: ReactNode) => {
    headerCapture.slotNode = node
    return null
  },
  useMobileFilterStrip: () => null,
}))

// 日历视图走 next/dynamic + recharts；jsdom 下用 stub 替身
vi.mock('next/dynamic', () => ({
  default: () =>
    function LazyCalendarStub() {
      return <div data-testid="calendar-stub" />
    },
}))

function analysisPayload() {
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
        dms_30: 1.2,
        dms_14: 1.3,
        dms_7: 1.4,
        dms_3: 1.5,
        base_dms: 1.2,
        safety_factor: 1.2,
        weighted_dms: 1.18,
        sellable_days: 84,
        sellout_date: '2026-11-19',
        sellout_date_with_transit: '2027-01-05',
        production_lead_days: 30,
        shipping_days: 45,
        replenishment_order_date: null,
        warehouse_entry_date: null,
        shipment_order_date: null,
        estimated_replenishment_quantity: 200,
        risk_status: '断货风险',
        risk_anchor_date: null,
        inventory_state: 'critical',
        replenishment_action: 'REPLENISH_NOW',
        signals: null,
        decision_path: null,
      },
    ],
    summary: {
      sku_count: 1,
      out_of_stock_risk_count: 1,
      healthy_count: 0,
      slow_moving_count: 0,
      pending_data_count: 0,
      total_available_inventory: 100,
      total_in_transit_quantity: 50,
      critical_count: 1,
      deteriorating_count: 0,
      watch_count: 0,
      healthy_count_v2: 0,
      unknown_count: 0,
    },
    page: 1,
    page_size: 200,
    total: 1,
    has_next: false,
  }
}

const SNAPSHOT_OPTION = {
  id: 9,
  project_id: 1,
  project_name: '项目A',
  country: 'US',
  snapshot_date: '2026-08-01T00:00:00Z',
  is_current: false,
  name: '测试快照',
  description: null,
  inventory_report_date: null,
  business_report_date: null,
  sales_report_date: null,
  row_count: 1,
  created_by: '测试用户',
  created_at: '2026-08-01T00:00:00Z',
  summary: {
    sku_count: 1,
    out_of_stock_risk_count: 1,
    healthy_count: 0,
    slow_moving_count: 0,
    pending_data_count: 0,
    total_available_inventory: 100,
    total_in_transit_quantity: 50,
  },
}

// fetchOpsJsonCached：记录每次请求的 url / force，供双模式刷新语义断言
const opsCacheCapture = vi.hoisted(() => ({
  lastUrl: undefined as string | undefined,
  lastForce: undefined as boolean | undefined,
}))
vi.mock('@/lib/ops-client-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ops-client-cache')>()
  return {
    ...actual,
    fetchOpsJsonCached: vi.fn().mockImplementation((url: string, opts?: { force?: boolean }) => {
      opsCacheCapture.lastUrl = url
      opsCacheCapture.lastForce = opts?.force
      return Promise.resolve(analysisPayload())
    }),
  }
})

import InventoryReplenishmentPage from './inventory-replenishment-client'
import { fetchOpsJsonCached } from '@/lib/ops-client-cache'

beforeEach(() => {
  nav.setParams('project=1&country=US')
  // 路由：快照列表端点返回一个可选快照；其余（行设置 PUT / 发货 / 快照 CRUD）默认 ok
  vi.stubGlobal(
    'fetch',
    vi.fn((url: unknown) => {
      if (String(url).includes('/inventory-replenishment-snapshots?')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([SNAPSHOT_OPTION]),
        })
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      })
    })
  )
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  headerCapture.refreshHandler = null
  headerCapture.refreshLoading = undefined
  headerCapture.slotNode = null
  opsCacheCapture.lastUrl = undefined
  opsCacheCapture.lastForce = undefined
})

// ── 测试 ──────────────────────────────────────────────────────────────────────

describe('补货分析页 header 化渲染契约（operations header migration B1）', () => {
  it('渲染不崩溃：指挥带、3 tabs、导出、快照入口、口径说明保留', async () => {
    render(<InventoryReplenishmentPage />)
    // 决策工作台（默认 tab）渲染数据行
    expect(await screen.findByText('SKU-001')).toBeInTheDocument()
    // CockpitOverview 指挥带保留
    expect(screen.getByText('状态光谱')).toBeInTheDocument()
    expect(screen.getByText('行动全景')).toBeInTheDocument()
    // 3 tabs 保留
    expect(screen.getByRole('tab', { name: /决策工作台/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /表格视图/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /日历视图/ })).toBeInTheDocument()
    // 导出保留
    expect(screen.getByRole('button', { name: /导出 Excel/ })).toBeInTheDocument()
    // SnapshotSelector 留正文（实时数据 / 快照入口）
    expect(screen.getByRole('button', { name: /实时数据/ })).toBeInTheDocument()
    // 口径说明保留
    expect(screen.getByText('口径说明')).toBeInTheDocument()
  })

  it('4 个筛选控件注册进头部插槽（项目/关键词/站点/风险状态），正文不再渲染', async () => {
    render(<InventoryReplenishmentPage />)
    await screen.findByText('SKU-001')
    expect(headerCapture.slotNode).not.toBeNull()

    // 正文（插槽 mock 不渲染 portal 内容）不应出现筛选控件
    expect(screen.queryByPlaceholderText('搜索 SKU / ASIN')).not.toBeInTheDocument()
    expect(screen.queryByText('全部状态')).not.toBeInTheDocument()

    // 单独渲染插槽节点：4 个控件确实都在插槽内容里
    render(<>{headerCapture.slotNode}</>)
    expect(await screen.findByPlaceholderText('搜索 SKU / ASIN')).toBeInTheDocument()
    expect(screen.getByText('全部状态')).toBeInTheDocument()
    expect(screen.getByText('项目A')).toBeInTheDocument()
    expect(screen.getByText('美国站 (US)')).toBeInTheDocument()
  })

  it('旧控制台已移除：无「刷新重算」按钮、无「控制台」文案', async () => {
    render(<InventoryReplenishmentPage />)
    await screen.findByText('SKU-001')
    expect(screen.queryByRole('button', { name: /刷新重算/ })).not.toBeInTheDocument()
    expect(screen.queryByText('控制台')).not.toBeInTheDocument()
  })

  it('非快照模式：头部刷新回调触发 refreshWithSave——先持久化行编辑再 force 重载，loading 上报', async () => {
    const user = userEvent.setup()
    render(<InventoryReplenishmentPage />)
    await screen.findByText('SKU-001')
    expect(headerCapture.refreshHandler).not.toBeNull()

    // 切到表格视图，制造一条未保存的行编辑（生产交货 30 → 35）
    await user.click(screen.getByRole('tab', { name: /表格视图/ }))
    const leadTimeInputs = await screen.findAllByDisplayValue('30')
    expect(leadTimeInputs.length).toBeGreaterThan(0)
    fireEvent.change(leadTimeInputs[0], { target: { value: '35' } })

    // 受控 deferred 挂起 force 重载，确定性断言保存发生 + loading 上报
    let resolveReload: ((value: unknown) => void) | undefined
    vi.mocked(fetchOpsJsonCached).mockImplementationOnce(
      (url: string, opts?: { force?: boolean }) => {
        opsCacheCapture.lastUrl = url
        opsCacheCapture.lastForce = opts?.force
        return new Promise((resolve) => {
          resolveReload = resolve
        })
      }
    )

    act(() => {
      headerCapture.refreshHandler?.()
    })

    // 保存发生：行设置 PUT 请求发出（act 包裹等待，吸收异步状态更新）
    await act(async () => {
      await vi.waitFor(() => {
        const putCalls = vi.mocked(fetch).mock.calls.filter(
          ([url, init]) =>
            String(url).includes('/inventory-replenishment-settings/') &&
            (init as RequestInit | undefined)?.method === 'PUT'
        )
        expect(putCalls.length).toBe(1)
      })
    })

    // 保存后 force 重载（跳 2min 缓存）
    await vi.waitFor(() => expect(opsCacheCapture.lastForce).toBe(true))
    expect(opsCacheCapture.lastUrl).toContain('/inventory-replenishment-analysis?')
    // loading（refreshingAll）上报给全局刷新按钮
    await vi.waitFor(() => expect(headerCapture.refreshLoading).toBe(true))

    // 放行重载后 loading 回落
    await act(async () => {
      resolveReload?.(analysisPayload())
    })
    await vi.waitFor(() => expect(headerCapture.refreshLoading).toBe(false))
  })

  it('快照模式：头部刷新回调降级为不带 save 的 force 重载（保存未发生）', async () => {
    const user = userEvent.setup()
    render(<InventoryReplenishmentPage />)
    await screen.findByText('SKU-001')

    // 打开快照下拉并选中「测试快照」→ 进入快照模式
    await user.click(screen.getByRole('button', { name: /实时数据/ }))
    await user.click(await screen.findByText('测试快照'))

    // 快照 items 端点完成首次加载（loading 回落，避免 handler 被 loading 守卫拦下）
    await vi.waitFor(() =>
      expect(opsCacheCapture.lastUrl).toContain('/inventory-replenishment-snapshots/9/items')
    )
    await vi.waitFor(() => expect(headerCapture.refreshLoading).toBe(false))

    // 清空 fetch 记录：之后若出现 PUT 即为快照态误触发保存
    vi.mocked(fetch).mockClear()

    // 受控 deferred 挂起本次 force 重载
    let resolveReload: ((value: unknown) => void) | undefined
    vi.mocked(fetchOpsJsonCached).mockImplementationOnce(
      (url: string, opts?: { force?: boolean }) => {
        opsCacheCapture.lastUrl = url
        opsCacheCapture.lastForce = opts?.force
        return new Promise((resolve) => {
          resolveReload = resolve
        })
      }
    )

    act(() => {
      headerCapture.refreshHandler?.()
    })

    // force 重载命中快照 items 端点（而非实时分析端点）
    await vi.waitFor(() => expect(opsCacheCapture.lastForce).toBe(true))
    expect(opsCacheCapture.lastUrl).toContain('/inventory-replenishment-snapshots/9/items')
    // loading 上报
    await vi.waitFor(() => expect(headerCapture.refreshLoading).toBe(true))
    // 保存未发生：无任何行设置 PUT
    const putCalls = vi.mocked(fetch).mock.calls.filter(
      ([url, init]) =>
        String(url).includes('/inventory-replenishment-settings/') &&
        (init as RequestInit | undefined)?.method === 'PUT'
    )
    expect(putCalls.length).toBe(0)

    // 放行后 loading 回落
    await act(async () => {
      resolveReload?.(analysisPayload())
    })
    await vi.waitFor(() => expect(headerCapture.refreshLoading).toBe(false))
  })
})
