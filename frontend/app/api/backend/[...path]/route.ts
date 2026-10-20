export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'

import { requireUserSession } from '@/lib/auth/server'
import { tryCachedBackendGet } from '@/lib/server/backend-cache'
import { normalizeErrorMessage } from '@/lib/error-utils'
import {
  buildBackendProxyHeaders,
  buildBackendUrl,
  getProxyRequestBody,
  toProxyResponse,
} from '@/lib/server/backend-proxy'
import { appendApiKeyQuery } from '@/lib/server/backend-api'
import { getProxyTimeoutMs } from '@/lib/server/backend-proxy-timeout-policy'

async function proxy(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params
  const session = await requireUserSession()
  if (!session) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 })
  }

  const joinedPath = Array.isArray(path) ? path.join('/') : ''
  if (!joinedPath) {
    return NextResponse.json({ message: 'Invalid backend path' }, { status: 400 })
  }

  // Strip the /api/backend prefix that Next.js adds, leaving the backend path.
  // e.g. /api/backend/v1/projects → v1/projects
  //      /api/backend/api/v1/projects → api/v1/projects
  let backendPath = joinedPath.replace(/^\/?api\/backend\//, '')

  // Normalize: ensure the path starts with 'api/' so buildBackendUrl produces
  // http://base/api/v1/... (not http://base/v1/... which the backend rejects).
  // buildBackendUrl('api/v1/...') → http://base/api/v1/...  ✓
  // buildBackendUrl('v1/...')     → http://base/v1/...      ✗
  if (!backendPath.startsWith('api/')) {
    backendPath = 'api/' + backendPath
  }

  if (!backendPath || backendPath === 'api/') {
    return NextResponse.json({ message: 'Invalid backend path' }, { status: 400 })
  }

  const search = request.nextUrl.search || ''
  const requestAccept = request.headers.get('accept')

  // Try the cache path first for allowlisted high-frequency GETs. Returns
  // a Response on cache hit/miss, or `null` when the path is not cacheable
  // (or method is not GET/HEAD) — in which case we fall through to the
  // live fetch below. The cache key is user-scoped (X-User-Id) + query-
  // scoped, see `lib/server/backend-cache.ts`.
  try {
    const cached = await tryCachedBackendGet({
      backendPath,
      search,
      session,
      requestHeaders: request.headers,
      method: request.method,
    })
    if (cached) return cached
  } catch (error) {
    // Cache failures must NEVER break the request — log and fall through.
    console.warn(
      '[proxy] backend cache failed, falling through to live fetch:',
      normalizeErrorMessage(error, 'unknown')
    )
  }

  // Endpoint-tiered timeout: stream → no timeout, AI / report → 30-60s,
  // detail / list → 5-10s. See `backend-proxy-timeout-policy.ts` for the
  // tier table and matching rules. The request method participates because
  // some endpoints share one path across methods with very different cost
  // profiles (BLF-1404: `POST /crm/proposals` uploads a 20MB HTML while
  // `GET /crm/proposals` is a cheap list).
  const timeoutMs = getProxyTimeoutMs(backendPath, requestAccept, request.method)
  const timeoutSignal = timeoutMs === 0 ? undefined : AbortSignal.timeout(timeoutMs)
  // Preserve client cancellation (including streams) while adding the proxy
  // deadline. If either signal aborts, cancel the upstream request promptly.
  const upstreamSignal = timeoutSignal
    ? AbortSignal.any([request.signal, timeoutSignal])
    : request.signal

  try {
    const response = await fetch(`${buildBackendUrl(backendPath)}${appendApiKeyQuery(search)}`, {
      method: request.method,
      headers: buildBackendProxyHeaders(session, request.headers),
      body: await getProxyRequestBody(request),
      cache: 'no-store',
      signal: upstreamSignal,
    })
    return await toProxyResponse(response)
  } catch (error) {
    // A caller closing the page is not a backend failure. Use the conventional
    // 499 status for observability if the runtime still expects a response.
    if (request.signal.aborted) return new NextResponse(null, { status: 499 })

    // A proxy-owned deadline is a gateway timeout, not a generic 500. The
    // overview timeout is deliberately a little longer than the backend's
    // 15s statement_timeout so its actionable backend 504 can normally pass
    // through first; this handles network/runtime deadlines separately.
    if (timeoutSignal?.aborted) {
      const isOrderOverview = /\/order-info\/overview(?:\?|$)/.test(backendPath + search)
      return NextResponse.json(
        {
          message: isOrderOverview
            ? '订单概览查询超时，请缩小店铺或日期范围后重试。'
            : '请求后端服务超时，请稍后重试。',
        },
        { status: 504 }
      )
    }

    return NextResponse.json(
      { message: normalizeErrorMessage(error, '后端服务暂时不可用，请联系管理员') },
      { status: 500 }
    )
  }
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE }
