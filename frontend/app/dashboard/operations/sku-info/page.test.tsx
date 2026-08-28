import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── mocks ────────────────────────────────────────────────────────────────────

// 稳定引用：避免每次渲染产生新对象导致 session/notify identity 抖动、
// useEffect 重复触发、双重 fetch、loading 断言竞态
// （真实 useSession / useNotifications 返回稳定引用）
const { stableSession, mockNotify, mockConfirm, fetchMock } = vi.hoisted(() => ({
  stableSession: { user: { id: 'user-1', roleType: 'admin' } },
  mockNotify: vi.fn(),
  mockConfirm: vi.fn().mockResolvedValue(true),
  fetchMock: vi.fn(),
}))

vi.mock('next-auth/react', () => ({
  useSession: () => ({
    data: stableSession,
    status: 'authenticated' as const,
  }),
}))

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard/operations/sku-info',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}))

vi.mock('@/components/notifications', () => ({
  useNotifications: () => ({ notify: mockNotify }),
}))

vi.mock('@/hooks/use-confirm', () => ({
  useConfirm: () => ({ confirm: mockConfirm }),
}))

vi.mock('@/lib/project-client-cache', () => ({
  fetchManagedProjectsCached: vi.fn().mockResolvedValue([
    { id: 1, name: '项目A' },
    { id: 2, name: '项目B' },
  ]),
}))

// 捕获 header 刷新回调 / loading 上报；插槽节点原位渲染（mock 掉 portal）供交互断言
let capturedRefreshHandler: (() => void | Promise<void>) | null = null
let capturedRefreshLoading: boolean | undefined
let capturedSlotNode: ReactNode = null
vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: (handler: () => void | Promise<void>, opts?: { loading?: boolean }) => {
    capturedRefreshHandler = handler
    capturedRefreshLoading = opts?.loading
    return { setLoading: vi.fn() }
  },
  useHeaderSlot: (node: ReactNode) => {
    capturedSlotNode = node
    return node
  },
}))

// ── fixtures ─────────────────────────────────────────────────────────────────

function skuItem(overrides?: Record<string, unknown>) {
  return {
    id: 1,
    project_name: '项目A',
    sku: 'SKU-001',
    asin: 'B0AAAAAAA1',
    fnsku: 'FNSKU-001',
    product_name: '测试商品一',
    fob_unit_cost: 2.57,
    first_leg_cost_rmb: 1.2,
    package_length_cm: 18.5,
    package_width_cm: 12,
    package_height_cm: 5.2,
    weight_kg: 0.68,
    carton_length_cm: 42,
    carton_width_cm: 28,
    carton_height_cm: 30,
    carton_weight_kg: 9.2,
    units_per_carton: 12,
    currency: 'CNY',
    country: 'US',
    sort_order: 1,
    is_active: true,
    sku_factory_info: null,
    sku_factory_info_updated_at: null,
    sku_factory_info_updated_by: null,
    ...overrides,
  }
}

function skuPagePayload(overrides?: Record<string, unknown>) {
  return {
    items: [skuItem()],
    page: 1,
    page_size: 10000,
    total: 1,
    has_next: false,
    ...overrides,
  }
}

function jsonResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
    blob: () => Promise.resolve(new Blob([])),
    headers: new Headers(),
  }
}

function defaultFetchImpl(url: string) {
  if (url.includes('/shipment-schedules/sku-summary')) {
    return Promise.resolve(jsonResponse({ items: [] }))
  }
  if (url.includes('/api/v1/sku-info')) {
    return Promise.resolve(jsonResponse(skuPagePayload()))
  }
  return Promise.resolve(jsonResponse({}))
}

import SkuInfoPage from './page'

// ── helpers ──────────────────────────────────────────────────────────────────

/** 项目下拉由 fetchManagedProjectsCached 异步填充；等到 trigger 可用即列表就绪 */
async function waitForProjectsReady() {
  await waitFor(() => expect(screen.getByTitle('项目筛选')).toBeEnabled())
}

/** Radix Select 打开（jsdom 下 pointerDown + click，与 header-filter-suite.test 同款） */
function openSelect(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { pointerType: 'mouse', ctrlKey: false })
  fireEvent.click(trigger)
}

beforeEach(() => {
  fetchMock.mockImplementation(defaultFetchImpl)
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  capturedRefreshHandler = null
  capturedRefreshLoading = undefined
  capturedSlotNode = null
})

// ── tests ────────────────────────────────────────────────────────────────────

describe('SkuInfoPage header 化渲染契约（operations header migration B3）', () => {
  it('渲染不崩溃：5 tabs 与 ActionsBar 保留，初始无自动查询（提交制）', async () => {
    render(<SkuInfoPage />)
    // 5 tabs 保留（「成本管理」在 tab trigger 与卡头标题各出现一次）
    expect((await screen.findAllByText('成本管理')).length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('尺寸管理')).toBeInTheDocument()
    expect(screen.getByText('产品属性')).toBeInTheDocument()
    expect(screen.getByText('产品标签')).toBeInTheDocument()
    expect(screen.getByText('产品图片')).toBeInTheDocument()
    // ActionsBar 保留（模板下载 / 批量导入 / 同步头程运费）；
    // 批量上新/批量修改是 asChild label（包隐藏 file input），按文本断言
    expect(screen.getByRole('button', { name: /下载上新模板/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /导出批量修改/ })).toBeInTheDocument()
    expect(screen.getByText('批量上新')).toBeInTheDocument()
    expect(screen.getByText('批量修改')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /同步头程/ })).toBeInTheDocument()
    // 空态 + 初始无任何自动查询（提交制：无 URL 参数时不 fetch）
    expect(
      screen.getByText('暂无数据，请输入项目名或 SKU/ASIN 进行查询。')
    ).toBeInTheDocument()
    await waitForProjectsReady()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('筛选控件注册进头部插槽；旧控制台卡片壳已移除', async () => {
    const { container } = render(<SkuInfoPage />)
    await waitForProjectsReady()
    // 插槽节点非空（3 select + 2 input + 查询/重置经 useHeaderSlot 上移）
    expect(capturedSlotNode).not.toBeNull()
    // 旧控制台 dashboard-surface 卡片壳与字段标签已删除
    expect(container.querySelector('.dashboard-surface')).toBeNull()
    expect(screen.queryByText('国家站点')).not.toBeInTheDocument()
    // 全局唯一刷新入口：页内不再有页级「刷新」按钮（「同步头程」是写操作，不算刷新入口）
    expect(screen.queryByRole('button', { name: '刷新' })).not.toBeInTheDocument()
  })

  it('提交制语义：填写 SKU/ASIN 不触发查询', async () => {
    render(<SkuInfoPage />)
    await waitForProjectsReady()
    fireEvent.change(screen.getByPlaceholderText('输入 SKU'), { target: { value: 'SKU-001' } })
    fireEvent.change(screen.getByPlaceholderText('输入 ASIN'), {
      target: { value: 'B0AAAAAAA1' },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('提交制语义：选择项目不触发查询（旧 onProjectFilterChange 自动查询已移除）', async () => {
    render(<SkuInfoPage />)
    await waitForProjectsReady()
    const trigger = screen.getByTitle('项目筛选')
    openSelect(trigger)
    fireEvent.click(await screen.findByText('项目A'))
    await waitFor(() => expect(screen.getByTitle('项目筛选')).toHaveTextContent('项目A'))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('提交制语义：未填任何条件点「查询」→ notify「至少填一项」提示且不 fetch', async () => {
    render(<SkuInfoPage />)
    await waitForProjectsReady()
    fireEvent.click(screen.getByRole('button', { name: '查询' }))
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', title: '请输入项目名或 SKU/ASIN 进行查询' })
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('提交制语义：点「查询」才 loadData（选中项目时附带 sku-summary 请求）', async () => {
    render(<SkuInfoPage />)
    await waitForProjectsReady()

    // 选择项目（不触发查询）
    const trigger = screen.getByTitle('项目筛选')
    openSelect(trigger)
    fireEvent.click(await screen.findByText('项目A'))
    await waitFor(() => expect(screen.getByTitle('项目筛选')).toHaveTextContent('项目A'))
    // 填写 SKU（不触发查询）
    fireEvent.change(screen.getByPlaceholderText('输入 SKU'), { target: { value: 'SKU-001' } })
    expect(fetchMock).not.toHaveBeenCalled()

    // 点「查询」才执行 loadData
    fireEvent.click(screen.getByRole('button', { name: '查询' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    const mainUrl = String(fetchMock.mock.calls[0]?.[0])
    expect(mainUrl).toContain('/api/v1/sku-info?')
    expect(mainUrl).toContain('sku=SKU-001')
    expect(mainUrl).toContain('project_name=')
    // 选中项目后附带 sku-summary（头程历史加权）请求
    const summaryUrl = String(fetchMock.mock.calls[1]?.[0])
    expect(summaryUrl).toContain('/shipment-schedules/sku-summary')
    expect(summaryUrl).toContain('project_id=1')

    // 数据渲染
    expect(await screen.findByText('SKU-001')).toBeInTheDocument()
  })

  it('SKU 输入框回车 = 显式提交查询（提交制内的便捷触发）', async () => {
    render(<SkuInfoPage />)
    await waitForProjectsReady()
    const input = screen.getByPlaceholderText('输入 SKU')
    fireEvent.change(input, { target: { value: 'SKU-001' } })
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    // 数据渲染即证明查询经回车显式触发（findByText 为 act 包装，顺带 flush 异步更新）
    expect(await screen.findByText('SKU-001')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('sku=SKU-001')
  })

  it('头部刷新：无有效查询 → no-op（不 fetch）+ notify 提示', async () => {
    render(<SkuInfoPage />)
    await waitForProjectsReady()
    expect(capturedRefreshHandler).not.toBeNull()
    act(() => {
      void capturedRefreshHandler?.()
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'info', title: '请先填写查询条件' })
    )
  })

  it('头部刷新：有有效查询 → 重跑当前查询，loading 上报且完成后回落', async () => {
    render(<SkuInfoPage />)
    await waitForProjectsReady()

    // 先建立一次有效查询
    fireEvent.change(screen.getByPlaceholderText('输入 SKU'), { target: { value: 'SKU-001' } })
    fireEvent.click(screen.getByRole('button', { name: '查询' }))
    expect(await screen.findByText('SKU-001')).toBeInTheDocument()
    const callsBefore = fetchMock.mock.calls.length

    // 用受控 deferred Promise 挂起本次重拉，确定性断言 loading 上报
    let resolveFetch: ((value: unknown) => void) | undefined
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve
        })
    )

    act(() => {
      void capturedRefreshHandler?.()
    })
    // 以当前条件重跑（同一 sku 参数，新增一次请求）
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(callsBefore + 1))
    expect(String(fetchMock.mock.calls[callsBefore]?.[0])).toContain('sku=SKU-001')
    // loading 状态上报给全局刷新按钮
    await waitFor(() => expect(capturedRefreshLoading).toBe(true))

    // 放行请求后 loading 回落
    await act(async () => {
      resolveFetch?.(jsonResponse(skuPagePayload()))
    })
    await waitFor(() => expect(capturedRefreshLoading).toBe(false))
  })

  it('重置按钮：清空查询条件与结果，且不发起请求', async () => {
    render(<SkuInfoPage />)
    await waitForProjectsReady()

    // 先建立一次有效查询
    fireEvent.change(screen.getByPlaceholderText('输入 SKU'), { target: { value: 'SKU-001' } })
    fireEvent.click(screen.getByRole('button', { name: '查询' }))
    expect(await screen.findByText('SKU-001')).toBeInTheDocument()

    const callsBefore = fetchMock.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: '重置' }))
    // 输入清空、结果清空 → 空态文案回归
    expect(screen.getByPlaceholderText('输入 SKU')).toHaveValue('')
    expect(
      await screen.findByText('暂无数据，请输入项目名或 SKU/ASIN 进行查询。')
    ).toBeInTheDocument()
    expect(fetchMock.mock.calls.length).toBe(callsBefore)
  })
})
