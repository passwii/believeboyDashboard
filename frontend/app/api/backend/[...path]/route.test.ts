import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireUserSession: vi.fn(),
  tryCachedBackendGet: vi.fn(),
  normalizeErrorMessage: vi.fn((error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback
  ),
  buildBackendProxyHeaders: vi.fn(() => new Headers()),
  buildBackendUrl: vi.fn((path: string) => `https://backend.test/${path}`),
  getProxyRequestBody: vi.fn(async () => undefined),
  toProxyResponse: vi.fn(async (response: Response) => response),
  appendApiKeyQuery: vi.fn((search: string) => search),
}))

vi.mock('@/lib/auth/server', () => ({ requireUserSession: mocks.requireUserSession }))
vi.mock('@/lib/server/backend-cache', () => ({ tryCachedBackendGet: mocks.tryCachedBackendGet }))
vi.mock('@/lib/error-utils', () => ({ normalizeErrorMessage: mocks.normalizeErrorMessage }))
vi.mock('@/lib/server/backend-proxy', () => ({
  buildBackendProxyHeaders: mocks.buildBackendProxyHeaders,
  buildBackendUrl: mocks.buildBackendUrl,
  getProxyRequestBody: mocks.getProxyRequestBody,
  toProxyResponse: mocks.toProxyResponse,
}))
vi.mock('@/lib/server/backend-api', () => ({ appendApiKeyQuery: mocks.appendApiKeyQuery }))

import { GET, POST } from './route'

function makeRequest(signal?: AbortSignal) {
  return new NextRequest('https://dashboard.test/api/backend/api/v1/order-info/overview?page=1', {
    method: 'GET',
    signal,
  })
}

const routeContext = { params: Promise.resolve({ path: ['api', 'v1', 'order-info', 'overview'] }) }

describe('backend proxy cancellation and overview deadline', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
    mocks.requireUserSession.mockResolvedValue({ user: { id: 'user-1' } })
    mocks.tryCachedBackendGet.mockResolvedValue(null)
  })

  it('propagates client abort to the upstream signal and does not classify it as a proxy failure', async () => {
    const client = new AbortController()
    let upstreamSignal: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        upstreamSignal = init?.signal as AbortSignal
        client.abort()
        throw new DOMException('The operation was aborted', 'AbortError')
      })
    )

    const response = await GET(makeRequest(client.signal), routeContext)

    expect(upstreamSignal?.aborted).toBe(true)
    expect(response.status).toBe(499)
  })

  it('returns a clear 504 when the proxy deadline aborts the overview request', async () => {
    const deadline = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        deadline.abort()
        throw new DOMException('The operation timed out', 'TimeoutError')
      })
    )

    const response = await GET(makeRequest(), routeContext)

    expect(response.status).toBe(504)
    expect(await response.json()).toEqual({
      message: '订单概览查询超时，请缩小店铺或日期范围后重试。',
    })
  })

  it('maps other proxy deadline expirations to 504 with a generic message', async () => {
    const deadline = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        deadline.abort()
        throw new DOMException('The operation timed out', 'TimeoutError')
      })
    )

    const response = await GET(
      new NextRequest('https://dashboard.test/api/backend/api/v1/projects/manage', { method: 'GET' }),
      { params: Promise.resolve({ path: ['api', 'v1', 'projects', 'manage'] }) }
    )

    expect(response.status).toBe(504)
    expect(await response.json()).toEqual({ message: '请求后端服务超时，请稍后重试。' })
  })

  it('preserves an upstream database statement-timeout 504 and its actionable detail', async () => {
    const detail = 'order_info_query_timeout: 订单查询超过服务端上限（15000ms），请收窄店铺或日期范围后重试'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ detail }), {
          status: 504,
          headers: { 'content-type': 'application/json' },
        })
      )
    )

    const response = await GET(makeRequest(), routeContext)

    expect(response.status).toBe(504)
    expect(await response.json()).toEqual({ detail })
  })

  it('keeps non-timeout upstream proxy errors distinct from timeouts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connection refused') }))

    const response = await GET(makeRequest(), routeContext)

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ message: 'connection refused' })
  })
})

/**
 * BLF-1404：客户方案上传 20MB HTML 需要代理给足 deadline（60s）。
 *
 * 代理路由（`app/api/backend/[...path]/route.ts`）把 `request.method` 一并
 * 交给档位表 → 同一个 `api/v1/crm/proposals` 路径：
 *   POST（建方案，20MB 上传）→ 60s
 *   GET （列表）              → 5s
 * 这里直接断言代理传给 `AbortSignal.timeout` 的毫秒数，锁住「路由确实把
 * method 透传下去了」——只看档位表的单测证明不了这一点。
 */
describe('BLF-1404: 方案上传按 method 分档的代理 deadline', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
    mocks.requireUserSession.mockResolvedValue({ user: { id: 'user-1' } })
    mocks.tryCachedBackendGet.mockResolvedValue(null)
    mocks.getProxyRequestBody.mockResolvedValue(undefined)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
  })

  it('POST 建方案用 60s deadline', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')

    await POST(
      new NextRequest('https://dashboard.test/api/backend/api/v1/crm/proposals', { method: 'POST' }),
      { params: Promise.resolve({ path: ['api', 'v1', 'crm', 'proposals'] }) }
    )

    expect(timeoutSpy).toHaveBeenCalledWith(60_000)
  })

  it('POST 追加版本用 60s deadline', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')

    await POST(
      new NextRequest('https://dashboard.test/api/backend/api/v1/crm/proposals/42/versions', {
        method: 'POST',
      }),
      { params: Promise.resolve({ path: ['api', 'v1', 'crm', 'proposals', '42', 'versions'] }) }
    )

    expect(timeoutSpy).toHaveBeenCalledWith(60_000)
  })

  it('GET 列表仍用 5s deadline（不被上传档误伤）', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')

    await GET(
      new NextRequest('https://dashboard.test/api/backend/api/v1/crm/proposals', { method: 'GET' }),
      { params: Promise.resolve({ path: ['api', 'v1', 'crm', 'proposals'] }) }
    )

    expect(timeoutSpy).toHaveBeenCalledWith(5_000)
  })
})
