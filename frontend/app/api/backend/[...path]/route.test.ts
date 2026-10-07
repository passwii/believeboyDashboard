import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireUserSession: vi.fn(),
  tryCachedBackendGet: vi.fn(),
  buildBackendProxyHeaders: vi.fn(),
  buildBackendUrl: vi.fn(),
  getProxyRequestBody: vi.fn(),
  toProxyResponse: vi.fn(),
  appendApiKeyQuery: vi.fn(),
  getProxyTimeoutTier: vi.fn(),
}))

vi.mock('@/lib/auth/server', () => ({ requireUserSession: mocks.requireUserSession }))
vi.mock('@/lib/server/backend-cache', () => ({ tryCachedBackendGet: mocks.tryCachedBackendGet }))
vi.mock('@/lib/server/backend-proxy', () => ({
  buildBackendProxyHeaders: mocks.buildBackendProxyHeaders,
  buildBackendUrl: mocks.buildBackendUrl,
  getProxyRequestBody: mocks.getProxyRequestBody,
  toProxyResponse: mocks.toProxyResponse,
}))
vi.mock('@/lib/server/backend-api', () => ({ appendApiKeyQuery: mocks.appendApiKeyQuery }))
vi.mock('@/lib/server/backend-proxy-timeout-policy', () => ({
  getProxyTimeoutTier: mocks.getProxyTimeoutTier,
}))

import { GET } from './route'

const routeParams = { params: Promise.resolve({ path: ['api', 'v1', 'order-info', 'overview'] }) }
const backendResponse = () => new Response(JSON.stringify({ ok: true }), { status: 200 })

function makeRequest(signal?: AbortSignal): NextRequest {
  return new NextRequest('http://localhost/api/backend/api/v1/order-info/overview', {
    headers: { accept: 'application/json' },
    signal,
  })
}

async function readBody(response: Response) {
  return (await response.json()) as Record<string, unknown>
}

describe('backend proxy cancellation and deadline', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
    mocks.requireUserSession.mockResolvedValue({ user: { id: 'user-1' } })
    mocks.tryCachedBackendGet.mockResolvedValue(null)
    mocks.buildBackendProxyHeaders.mockReturnValue(new Headers())
    mocks.buildBackendUrl.mockReturnValue('https://backend.example/api/v1/order-info/overview')
    mocks.getProxyRequestBody.mockResolvedValue(undefined)
    mocks.toProxyResponse.mockImplementation(async (response: Response) => response)
    mocks.appendApiKeyQuery.mockReturnValue('')
    mocks.getProxyTimeoutTier.mockReturnValue({ label: 'stats', timeoutMs: 15_000 })
  })

  it('merges the incoming request signal into the upstream request', async () => {
    const clientController = new AbortController()
    let upstreamSignal: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        upstreamSignal = init?.signal as AbortSignal
        return backendResponse()
      })
    )

    const response = await GET(makeRequest(clientController.signal), routeParams)

    expect(response.status).toBe(200)
    expect(upstreamSignal).toBeDefined()
    expect(upstreamSignal).not.toBe(clientController.signal)
    expect(upstreamSignal?.aborted).toBe(false)
  })

  it('returns 504 with timeout tier details when the proxy deadline aborts upstream fetch', async () => {
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const controller = new AbortController()
      controller.abort(new DOMException('timed out', 'TimeoutError'))
      return controller.signal
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const signal = init?.signal as AbortSignal
        if (signal.aborted) throw signal.reason
        return backendResponse()
      })
    )

    const response = await GET(makeRequest(), routeParams)

    expect(response.status).toBe(504)
    expect(await readBody(response)).toEqual({
      message: '后端响应超时',
      code: 'BACKEND_TIMEOUT',
      tier: 'stats',
      timeoutMs: 15_000,
    })
  })

  it('propagates client abort and returns 499 instead of misreporting a deadline', async () => {
    const clientController = new AbortController()
    let signalUpstreamStarted!: () => void
    const upstreamStarted = new Promise<void>((resolve) => {
      signalUpstreamStarted = resolve
    })
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        const signal = init?.signal as AbortSignal
        signalUpstreamStarted()
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      })
    )

    const responsePromise = GET(makeRequest(clientController.signal), routeParams)
    await upstreamStarted
    clientController.abort(new DOMException('client disconnected', 'AbortError'))
    const response = await responsePromise

    expect(response.status).toBe(499)
    expect(await readBody(response)).toEqual({ message: '请求已取消', code: 'REQUEST_ABORTED' })
  })

  it('keeps non-timeout upstream failures as HTTP 500', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connection reset') }))

    const response = await GET(makeRequest(), routeParams)

    expect(response.status).toBe(500)
    expect(await readBody(response)).toEqual({ message: 'connection reset' })
  })
})
