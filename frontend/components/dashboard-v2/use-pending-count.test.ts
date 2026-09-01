import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePendingCount } from './use-pending-count'

// ---- mocks -----------------------------------------------------------------

const mockUseSession = vi.fn()
vi.mock('next-auth/react', () => ({
  useSession: () => mockUseSession(),
}))

vi.mock('@/lib/backend-auth', () => ({
  buildBackendClientHeaders: (session: unknown) => ({ 'x-mock-session': String(session) }),
}))

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

// jsdom visibilityState 默认 visible
Object.defineProperty(document, 'visibilityState', {
  configurable: true,
  get: () => 'visible',
})

// ---- tests ------------------------------------------------------------------

describe('usePendingCount（BLF-928 实时计数轮询）', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    fetchMock.mockReset()
    mockUseSession.mockReturnValue({ data: { user: {} }, status: 'authenticated' })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('enabled=false 时不发起任何请求', () => {
    renderHook(() =>
      usePendingCount({ enabled: false, projectIds: [1], dateFrom: '2026-08-25', dateTo: '2026-08-31' })
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('BEL-422 护栏：项目为空 / 日期缺端时不请求', () => {
    renderHook(() =>
      usePendingCount({ enabled: true, projectIds: [], dateFrom: '2026-08-25', dateTo: '2026-08-31' })
    )
    renderHook(() =>
      usePendingCount({ enabled: true, projectIds: [1], dateFrom: '', dateTo: '2026-08-31' })
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('拉取 overview 读 total（Pending + 项目 + 日期窗口 + page_size=1）', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ items: [], total: 12 }),
    })
    const { result } = renderHook(() =>
      usePendingCount({ enabled: true, projectIds: [1, 2], dateFrom: '2026-08-25', dateTo: '2026-08-31' })
    )
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(result.current.count).toBe(12))
    const url = String(fetchMock.mock.calls[0]![0])
    expect(url).toContain('/api/backend/api/v1/order-info/overview?')
    expect(url).toContain('order_statuses=Pending')
    expect(url).toContain('project_ids=1')
    expect(url).toContain('project_ids=2')
    expect(url).toContain('date_from=2026-08-25')
    expect(url).toContain('date_to=2026-08-31')
    expect(url).toContain('page_size=1')
  })

  it('30s 轮询：interval 到点且页面可见时再次请求', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ items: [], total: 0 }) })
    renderHook(() =>
      usePendingCount({ enabled: true, projectIds: [1], dateFrom: '2026-08-25', dateTo: '2026-08-31' })
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('页面隐藏时 interval 到点不请求，回可见立即刷新', async () => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    })
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ items: [], total: 0 }) })
    renderHook(() =>
      usePendingCount({ enabled: true, projectIds: [1], dateFrom: '2026-08-25', dateTo: '2026-08-31' })
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // 隐藏期间轮询跳过
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // 回到可见：visibilitychange 触发立即拉取
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('refresh() 立即重拉（不等 30s 周期）', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ items: [], total: 0 }) })
    const { result } = renderHook(() =>
      usePendingCount({ enabled: true, projectIds: [1], dateFrom: '2026-08-25', dateTo: '2026-08-31' })
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    result.current.refresh()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('响应失败时静默保留上次计数，不抛错', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ items: [], total: 5 }) })
    fetchMock.mockResolvedValueOnce({ ok: false })
    const { result } = renderHook(() =>
      usePendingCount({ enabled: true, projectIds: [1], dateFrom: '2026-08-25', dateTo: '2026-08-31' })
    )
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(result.current.count).toBe(5))
    // 下一次轮询失败 → count 保持不变
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(result.current.count).toBe(5)
  })
})
