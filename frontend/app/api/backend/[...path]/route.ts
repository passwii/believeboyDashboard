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
    console.warn('[proxy] backend cache failed, falling through to live fetch:', normalizeErrorMessage(error, 'unknown'))
  }

  // Endpoint-tiered timeout: stream → no timeout, AI / report → 30-60s,
  // detail / list → 5-10s. See `backend-proxy-timeout-policy.ts` for the
  // tier table and matching rules.
  const timeoutMs = getProxyTimeoutMs(backendPath, requestAccept)

  try {
    const response = await fetch(`${buildBackendUrl(backendPath)}${search}`, {
      method: request.method,
      headers: buildBackendProxyHeaders(session, request.headers),
      body: await getProxyRequestBody(request),
      cache: 'no-store',
      // Stream endpoints: no timeout (let the connection close naturally when
      // the backend finishes or the client disconnects). Other endpoints:
      // the per-endpoint timeout from the tier table.
      ...(timeoutMs === 0 ? {} : { signal: AbortSignal.timeout(timeoutMs) }),
    })
    return await toProxyResponse(response)
  } catch (error) {
    return NextResponse.json(
      { message: normalizeErrorMessage(error, '后端服务暂时不可用，请联系管理员') },
      { status: 500 }
    )
  }
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE }
