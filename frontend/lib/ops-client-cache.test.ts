import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clearOpsClientCaches,
  fetchOpsJsonCached,
  normalizeOpsCacheQuery,
} from '@/lib/ops-client-cache'

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const SESSION = {
  user: {
    id: 'user-1',
    roleType: 'admin',
    name: '张三',
  },
} as never

const OTHER_SESSION = {
  user: {
    id: 'user-2',
    roleType: 'operator',
    name: '李四',
  },
} as never

describe('normalizeOpsCacheQuery', () => {
  it('参数排序后语义相同的 query 归一为同一字符串', () => {
    expect(normalizeOpsCacheQuery('b=2&a=1')).toBe(normalizeOpsCacheQuery('a=1&b=2'))
    expect(normalizeOpsCacheQuery('?b=2&a=1')).toBe('a=1&b=2')
    expect(normalizeOpsCacheQuery('')).toBe('')
  })
})

describe('fetchOpsJsonCached', () => {
  beforeEach(() => {
    clearOpsClientCaches()
    window.sessionStorage.clear()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    clearOpsClientCaches()
    window.sessionStorage.clear()
  })

  it('TTL 内重复请求命中缓存：只产生 1 次网络请求', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ ok: 1 }))
      .mockResolvedValueOnce(jsonResponse({ ok: 2 }))

    const first = await fetchOpsJsonCached<{ ok: number }>(
      '/api/backend/api/v1/daily-analysis?project_id=1&country=US',
      { session: SESSION }
    )
    const second = await fetchOpsJsonCached<{ ok: number }>(
      '/api/backend/api/v1/daily-analysis?project_id=1&country=US',
      { session: SESSION }
    )

    expect(first).toEqual({ ok: 1 })
    expect(second).toEqual({ ok: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('缓存键按用户域隔离：不同用户各自请求，不串数据', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ who: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse({ who: 'user-2' }))

    const a = await fetchOpsJsonCached<{ who: string }>('/api/backend/api/v1/return-analysis', {
      session: SESSION,
    })
    const b = await fetchOpsJsonCached<{ who: string }>('/api/backend/api/v1/return-analysis', {
      session: OTHER_SESSION,
    })

    expect(a.who).toBe('user-1')
    expect(b.who).toBe('user-2')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('TTL 过期后重新请求', async () => {
    vi.useFakeTimers()
    try {
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(jsonResponse({ v: 1 }))
        .mockResolvedValueOnce(jsonResponse({ v: 2 }))

      await fetchOpsJsonCached<{ v: number }>('/api/backend/api/v1/inventory-analysis', {
        session: SESSION,
      })
      vi.advanceTimersByTime(2 * 60 * 1000 + 1)
      const second = await fetchOpsJsonCached<{ v: number }>(
        '/api/backend/api/v1/inventory-analysis',
        { session: SESSION }
      )

      expect(second).toEqual({ v: 2 })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('force 跳过缓存读取（显式刷新）：重新请求并覆写缓存', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ v: 1 }))
      .mockResolvedValueOnce(jsonResponse({ v: 2 }))

    await fetchOpsJsonCached<{ v: number }>('/api/backend/api/v1/seasonal', { session: SESSION })
    const forced = await fetchOpsJsonCached<{ v: number }>('/api/backend/api/v1/seasonal', {
      session: SESSION,
      force: true,
    })
    // force 之后缓存已被覆写，普通读取直接命中新值
    const afterForce = await fetchOpsJsonCached<{ v: number }>('/api/backend/api/v1/seasonal', {
      session: SESSION,
    })

    expect(forced).toEqual({ v: 2 })
    expect(afterForce).toEqual({ v: 2 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('错误响应不进缓存：下一次调用重新请求', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ detail: '项目不存在' }, 404))
      .mockResolvedValueOnce(jsonResponse({ v: 1 }))

    await expect(
      fetchOpsJsonCached('/api/backend/api/v1/project-goals/progress', { session: SESSION })
    ).rejects.toThrow('项目不存在')

    const ok = await fetchOpsJsonCached<{ v: number }>(
      '/api/backend/api/v1/project-goals/progress',
      { session: SESSION }
    )
    expect(ok).toEqual({ v: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('并发同键请求去重为 1 个网络请求', async () => {
    let resolveFetch!: (value: Response) => void
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve
          })
      )

    const p1 = fetchOpsJsonCached<{ v: number }>('/api/backend/api/v1/dup', { session: SESSION })
    const p2 = fetchOpsJsonCached<{ v: number }>('/api/backend/api/v1/dup', { session: SESSION })
    resolveFetch(jsonResponse({ v: 7 }))

    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toEqual({ v: 7 })
    expect(r2).toEqual({ v: 7 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('clearOpsClientCaches 清空后重新请求（页内写操作后的失效路径）', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ v: 1 }))
      .mockResolvedValueOnce(jsonResponse({ v: 2 }))

    await fetchOpsJsonCached<{ v: number }>('/api/backend/api/v1/project-goals?x=1', {
      session: SESSION,
    })
    clearOpsClientCaches()
    const second = await fetchOpsJsonCached<{ v: number }>('/api/backend/api/v1/project-goals?x=1', {
      session: SESSION,
    })

    expect(second).toEqual({ v: 2 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
