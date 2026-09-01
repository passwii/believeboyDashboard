import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { usePendingOrders } from '@/components/dashboard-v2/use-pending-orders'

// ---- mocks -----------------------------------------------------------------

const mockUseSession = vi.fn()
vi.mock('next-auth/react', () => ({
  useSession: () => mockUseSession(),
}))

vi.mock('@/lib/backend-auth', () => ({
  buildBackendClientHeaders: () => ({ 'x-mock-session': 'test' }),
}))

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

// ---- fixtures ---------------------------------------------------------------

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(''),
  } as unknown as Response
}

const ROW_PAGE_1 = Array.from({ length: 20 }, (_, i) => ({
  id: i + 1,
  amazon_order_id: `111-0000000-00000${String(i + 1).padStart(2, '0')}`,
  sku: `SKU-${i + 1}`,
  asin: null,
  product_name: null,
  quantity: 1,
  item_price: 10,
  shipping_price: 0,
  currency: 'USD',
  country: 'US',
  purchase_at_utc: '2026-08-30T00:00:00Z',
  purchase_at_pt: '2026-08-29 12:00:00',
  order_status: 'Pending',
}))

const ROW_PAGE_2 = Array.from({ length: 5 }, (_, i) => ({
  ...ROW_PAGE_1[0]!,
  id: 21 + i,
  amazon_order_id: `111-0000000-00000${21 + i}`,
  sku: `SKU-${21 + i}`,
}))

// ---- tests -------------------------------------------------------------------

describe('usePendingOrders（BLF-927）', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    mockUseSession.mockReturnValue({ data: { user: {} }, status: 'authenticated' })
  })

  it('enabled=false 时不发请求（面板收起零请求）', () => {
    const { result } = renderHook(() =>
      usePendingOrders({
        enabled: false,
        projectIds: [1, 2],
        dateFrom: '2026-08-25',
        dateTo: '2026-08-31',
      })
    )
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.current.items).toEqual([])
  })

  it('BEL-422 护栏：项目列表为空时不发请求', () => {
    renderHook(() =>
      usePendingOrders({
        enabled: true,
        projectIds: [],
        dateFrom: '2026-08-25',
        dateTo: '2026-08-31',
      })
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('BEL-422 护栏：日期窗口缺失任一端时不发请求', () => {
    renderHook(() =>
      usePendingOrders({
        enabled: true,
        projectIds: [1],
        dateFrom: '',
        dateTo: '2026-08-31',
      })
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('展开时请求 overview：Pending 状态 + 项目 + 日期窗口 + 分页参数', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: ROW_PAGE_1.slice(0, 3), total: 3 }))
    const { result } = renderHook(() =>
      usePendingOrders({
        enabled: true,
        projectIds: [1, 2],
        dateFrom: '2026-08-25',
        dateTo: '2026-08-31',
      })
    )

    await waitFor(() => expect(result.current.items).toHaveLength(3))
    const url = String(fetchMock.mock.calls[0]![0])
    expect(url).toContain('/api/backend/api/v1/order-info/overview?')
    expect(url).toContain('order_statuses=Pending')
    expect(url).toContain('project_ids=1')
    expect(url).toContain('project_ids=2')
    expect(url).toContain('date_from=2026-08-25')
    expect(url).toContain('date_to=2026-08-31')
    expect(url).toContain('page=1')
    expect(url).toContain('sort_by=purchase_at_pt')
    expect(url).toContain('sort_dir=desc')
    expect(result.current.total).toBe(3)
    expect(result.current.hasMore).toBe(false)
  })

  it('loadMore 追加下一页数据（按 id 去重）', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      const page = Number(new URL(url, 'http://x.test').searchParams.get('page') ?? '1')
      return jsonResponse(page === 1 ? { items: ROW_PAGE_1, total: 25 } : { items: ROW_PAGE_2, total: 25 })
    })
    const { result } = renderHook(() =>
      usePendingOrders({
        enabled: true,
        projectIds: [1],
        dateFrom: '2026-08-25',
        dateTo: '2026-08-31',
      })
    )

    await waitFor(() => expect(result.current.items).toHaveLength(20))
    expect(result.current.hasMore).toBe(true)

    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.items).toHaveLength(25))
    // 第二页请求带 page=2
    const lastUrl = String(fetchMock.mock.calls.at(-1)![0])
    expect(lastUrl).toContain('page=2')
  })

  it('enabled 翻转（收起面板）时清空列表且 abort 在飞请求', async () => {
    let abortSignal: AbortSignal | undefined
    fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      abortSignal = init?.signal
      return jsonResponse({ items: ROW_PAGE_1, total: 20 })
    })
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        usePendingOrders({ enabled, projectIds: [1], dateFrom: '2026-08-25', dateTo: '2026-08-31' }),
      { initialProps: { enabled: true } }
    )

    await waitFor(() => expect(result.current.items).toHaveLength(20))
    // 收起面板
    rerender({ enabled: false })
    expect(result.current.items).toEqual([])
    expect(result.current.total).toBe(0)
    // 在飞请求已被 abort
    await waitFor(() => expect(abortSignal?.aborted).toBe(true))
  })

  it('请求失败时落 error 文案，不抛错', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve('内部错误'),
    } as unknown as Response)
    const { result } = renderHook(() =>
      usePendingOrders({
        enabled: true,
        projectIds: [1],
        dateFrom: '2026-08-25',
        dateTo: '2026-08-31',
      })
    )
    // 后端返回错误正文时优先透传（与 order-info 页 fetchData 同口径）
    await waitFor(() => expect(result.current.error).toBe('内部错误'))
    expect(result.current.loading).toBe(false)
  })

  it('日期窗口变化回到第 1 页重新拉取', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: ROW_PAGE_1.slice(0, 2), total: 2 }))
    const { result, rerender } = renderHook(
      ({ dateTo }: { dateTo: string }) =>
        usePendingOrders({ enabled: true, projectIds: [1], dateFrom: '2026-08-25', dateTo }),
      { initialProps: { dateTo: '2026-08-31' } }
    )

    await waitFor(() => expect(result.current.items).toHaveLength(2))
    rerender({ dateTo: '2026-08-30' })
    await waitFor(() => {
      const lastUrl = String(fetchMock.mock.calls.at(-1)![0])
      expect(lastUrl).toContain('date_to=2026-08-30')
      expect(lastUrl).toContain('page=1')
    })
  })
})
