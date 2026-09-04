import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useLiveStream } from './use-live-stream'

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

// jsdom 无 matchMedia/visibilitychange 之外的依赖；visibilityState 默认 visible
Object.defineProperty(document, 'visibilityState', {
  configurable: true,
  get: () => 'visible',
})

// ---- tests ------------------------------------------------------------------

describe('useLiveStream（BLF-839 接线）', () => {
  beforeEach(() => {
    // fake timers 需允许微任务推进，否则 waitFor 内部 setTimeout 永不触发
    vi.useFakeTimers({ shouldAdvanceTime: true })
    fetchMock.mockReset()
    mockUseSession.mockReturnValue({ data: { user: {} }, status: 'authenticated' })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('enabled=false 时不发起任何请求', () => {
    renderHook(() => useLiveStream(false))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('无 session 时不发起请求', () => {
    mockUseSession.mockReturnValue({ data: undefined })
    renderHook(() => useLiveStream(true))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('启用后拉取端点并把 occurred_at 格式化为相对时间', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          { id: 'o1', title: '订单 #A · $59.90', time_label: '2m', occurred_at: new Date(Date.now() - 5 * 60_000).toISOString() },
          { id: 'o2', title: '订单 #B · €42.00', occurred_at: 'not-a-date' },
        ],
      }),
    })
    const { result } = renderHook(() => useLiveStream(true))

    await vi.advanceTimersByTimeAsync(0)
    // shouldAdvanceTime 会推进真实时钟，相对时间文案存在 1 分钟级漂移——按结构断言而非精确文案
    await vi.waitFor(() => expect(result.current).toHaveLength(2))
    const [first, second] = result.current
    expect(first).toMatchObject({ id: 'o1', title: '订单 #A · $59.90' })
    expect(first.timeLabel).toMatch(/^刚刚|\d+ 分钟前$/)
    expect(second).toEqual({ id: 'o2', title: '订单 #B · €42.00', timeLabel: '' })
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('/api/backend/api/v1/order-info/live-stream')
    expect(url).toContain('limit=10')
  })

  it('响应失败时静默保留空数据，不抛错', async () => {
    fetchMock.mockResolvedValue({ ok: false })
    const { result } = renderHook(() => useLiveStream(true))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalled()
    expect(result.current).toEqual([])
  })

  it('30s 轮询：interval 到点且页面可见时再次请求', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ items: [] }) })
    renderHook(() => useLiveStream(true))
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
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ items: [] }) })
    renderHook(() => useLiveStream(true))
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
})
