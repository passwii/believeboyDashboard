import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clearAdClientCaches,
  fetchAdAnalysisCached,
  fetchAdJsonCached,
  fetchAdRawCached,
  fetchAdUploadFilesCached,
  normalizeAdCacheQuery,
} from '@/lib/ad-client-cache'

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

describe('normalizeAdCacheQuery', () => {
  it('参数排序后语义相同的 query 归一为同一字符串', () => {
    expect(normalizeAdCacheQuery('b=2&a=1')).toBe(normalizeAdCacheQuery('a=1&b=2'))
    expect(normalizeAdCacheQuery('?b=2&a=1')).toBe('a=1&b=2')
    expect(normalizeAdCacheQuery('')).toBe('')
  })
})

describe('fetchAdJsonCached', () => {
  beforeEach(() => {
    clearAdClientCaches()
    window.sessionStorage.clear()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    clearAdClientCaches()
    window.sessionStorage.clear()
  })

  it('TTL 内重复请求命中缓存：只产生 1 次网络请求', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ ok: 1 }))
      .mockResolvedValueOnce(jsonResponse({ ok: 2 }))

    const first = await fetchAdJsonCached<{ ok: number }>('/api/backend/x?project_id=1', {
      session: SESSION,
    })
    const second = await fetchAdJsonCached<{ ok: number }>('/api/backend/x?project_id=1', {
      session: SESSION,
    })

    expect(first).toEqual({ ok: 1 })
    expect(second).toEqual({ ok: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('缓存键按用户域隔离：不同用户各自请求，不串数据', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ who: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse({ who: 'user-2' }))

    const a = await fetchAdJsonCached<{ who: string }>('/api/backend/x?project_id=1', {
      session: SESSION,
    })
    const b = await fetchAdJsonCached<{ who: string }>('/api/backend/x?project_id=1', {
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

      await fetchAdJsonCached<{ v: number }>('/api/backend/y', { session: SESSION })
      vi.advanceTimersByTime(2 * 60 * 1000 + 1)
      const second = await fetchAdJsonCached<{ v: number }>('/api/backend/y', {
        session: SESSION,
      })

      expect(second).toEqual({ v: 2 })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('错误响应不进缓存：下一次调用重新请求', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ detail: '项目不存在' }, 404))
      .mockResolvedValueOnce(jsonResponse({ v: 1 }))

    await expect(
      fetchAdJsonCached('/api/backend/err', { session: SESSION })
    ).rejects.toThrow('项目不存在')

    const ok = await fetchAdJsonCached<{ v: number }>('/api/backend/err', { session: SESSION })
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

    const p1 = fetchAdJsonCached<{ v: number }>('/api/backend/dup', { session: SESSION })
    const p2 = fetchAdJsonCached<{ v: number }>('/api/backend/dup', { session: SESSION })
    resolveFetch(jsonResponse({ v: 7 }))

    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toEqual({ v: 7 })
    expect(r2).toEqual({ v: 7 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('具名封装的 URL 组装', () => {
  beforeEach(() => {
    clearAdClientCaches()
    window.sessionStorage.clear()
    vi.restoreAllMocks()
  })

  it('ad-analysis 端点按 tab 拼 URL', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}))
    await fetchAdAnalysisCached('overview', new URLSearchParams({ project_id: '1', country: 'US' }), SESSION)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/backend/api/v1/ad-analysis/overview?country=US&project_id=1',
      expect.anything()
    )
  })

  it('ad-upload-files 按项目/国家拼 URL', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([]))
    await fetchAdUploadFilesCached('3', 'DE', SESSION)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/backend/api/v1/internal/ad-data/projects/3/ad-upload-files?country=DE',
      expect.anything()
    )
  })

  it('ad-*-raw 按报表 endpoint 拼 URL', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ data: [] }))
    await fetchAdRawCached('3', 'campaigns', 'period=custom&limit=10000', SESSION)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/backend/api/v1/internal/ad-data/projects/3/ad-campaigns-raw?limit=10000&period=custom',
      expect.anything()
    )
  })
})
