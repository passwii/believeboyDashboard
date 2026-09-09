import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clearProjectClientCaches,
  fetchManagedProjectsCached,
  fetchProjectOperatorOptionsCached,
  fetchProjectOptionsCached,
} from '@/lib/project-client-cache'

// BEL-424 契约测试：projects / operator-options 共享端点的客户端缓存 ——
// 2min TTL、用户域隔离、在途去重（同页多组件并发 mount 只打一次后端）、错误不缓存。

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
    operatorNameZh: '张三',
  },
} as never

const OTHER_SESSION = {
  user: {
    id: 'user-2',
    roleType: 'operator',
    operatorNameZh: '李四',
  },
} as never

describe('fetchManagedProjectsCached', () => {
  beforeEach(() => {
    clearProjectClientCaches()
    window.sessionStorage.clear()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    clearProjectClientCaches()
    window.sessionStorage.clear()
  })

  it('TTL 内重复请求命中缓存：只产生 1 次网络请求', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse([{ id: 1, name: 'A' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 2, name: 'B' }]))

    const first = await fetchManagedProjectsCached<Array<{ id: number }>>(SESSION)
    const second = await fetchManagedProjectsCached<Array<{ id: number }>>(SESSION)

    expect(first).toEqual([{ id: 1, name: 'A' }])
    expect(second).toEqual([{ id: 1, name: 'A' }])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('缓存键按用户域隔离：不同用户各自请求，不串数据', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse([{ id: 1, name: 'user-1 的项目' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 9, name: 'user-2 的项目' }]))

    const a = await fetchManagedProjectsCached<Array<{ name: string }>>(SESSION)
    const b = await fetchManagedProjectsCached<Array<{ name: string }>>(OTHER_SESSION)

    expect(a[0].name).toBe('user-1 的项目')
    expect(b[0].name).toBe('user-2 的项目')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('show_inactive 走独立缓存键：不与普通列表互相污染', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse([{ id: 1, name: 'active' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 1, name: 'active' }, { id: 2, name: 'inactive' }]))

    const active = await fetchManagedProjectsCached<Array<{ id: number }>>(SESSION)
    const all = await fetchManagedProjectsCached<Array<{ id: number }>>(SESSION, true)

    expect(active).toHaveLength(1)
    expect(all).toHaveLength(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]?.[0]).toContain('show_inactive=true')
  })

  it('TTL 过期后重新请求', async () => {
    vi.useFakeTimers()
    try {
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(jsonResponse([{ id: 1 }]))
        .mockResolvedValueOnce(jsonResponse([{ id: 2 }]))

      await fetchManagedProjectsCached<Array<{ id: number }>>(SESSION)
      vi.advanceTimersByTime(2 * 60 * 1000 + 1)
      const second = await fetchManagedProjectsCached<Array<{ id: number }>>(SESSION)

      expect(second).toEqual([{ id: 2 }])
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('并发同键请求去重为 1 个网络请求（同页多组件同时 mount）', async () => {
    let resolveFetch!: (value: Response) => void
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve
          })
      )

    const p1 = fetchManagedProjectsCached<Array<{ id: number }>>(SESSION)
    const p2 = fetchManagedProjectsCached<Array<{ id: number }>>(SESSION)
    resolveFetch(jsonResponse([{ id: 7 }]))

    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toEqual([{ id: 7 }])
    expect(r2).toEqual([{ id: 7 }])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('错误响应不进缓存：下一次调用重新请求', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ detail: '项目不存在' }, 404))
      .mockResolvedValueOnce(jsonResponse([{ id: 1 }]))

    await expect(fetchManagedProjectsCached(SESSION)).rejects.toThrow('项目不存在')

    const ok = await fetchManagedProjectsCached<Array<{ id: number }>>(SESSION)
    expect(ok).toEqual([{ id: 1 }])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('clearProjectClientCaches 清空后重新请求（项目写操作后的失效路径）', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse([{ id: 1 }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 1 }, { id: 2 }]))

    await fetchManagedProjectsCached<Array<{ id: number }>>(SESSION)
    clearProjectClientCaches()
    const second = await fetchManagedProjectsCached<Array<{ id: number }>>(SESSION)

    expect(second).toHaveLength(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('force 请求附带缓存破坏参数，避免服务端项目列表缓存覆盖刚保存的状态', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse([{ id: 1 }]))

    await fetchManagedProjectsCached<Array<{ id: number }>>(SESSION, true, { force: true })

    expect(fetchMock.mock.calls[0]?.[0]).toMatch(
      /^\/api\/backend\/api\/v1\/projects\/manage\?show_inactive=true&_cache_bust=\d+$/
    )
  })
 })

describe('fetchProjectOptionsCached / fetchProjectOperatorOptionsCached', () => {
  beforeEach(() => {
    clearProjectClientCaches()
    window.sessionStorage.clear()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    clearProjectClientCaches()
    window.sessionStorage.clear()
  })

  it('projects 选项列表与 operator-options 各自 TTL 内只请求一次', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: 1, name: 'A' }] }))
      .mockResolvedValueOnce(jsonResponse(['张三', '李四']))

    await fetchProjectOptionsCached<{ items: Array<{ id: number }> }>()
    await fetchProjectOptionsCached<{ items: Array<{ id: number }> }>()
    await fetchProjectOperatorOptionsCached()
    await fetchProjectOperatorOptionsCached()

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
