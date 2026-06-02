export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'

import { requireUserSession } from '@/lib/auth/server'
import { normalizeErrorMessage } from '@/lib/error-utils'
import {
  buildBackendProxyHeaders,
  buildBackendUrl,
  getProxyRequestBody,
  toProxyResponse,
} from '@/lib/server/backend-proxy'

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

  // Streaming endpoints (SSE / NDJSON) MUST NOT have a 10s timeout — AI
  // insight generation can take 30-80s. Detect by URL pattern; the response
  // content-type is checked again in toProxyResponse for safety.
  // - /ai-insights/{id}/stream (SSE)
  // - /ai-insights/generate/stream (legacy NDJSON, kept for back-compat)
  const isStreamEndpoint = /\/ai-insights\/.+\/stream$/.test(backendPath) || /\/ai-insights\/generate\/stream$/.test(backendPath)

  // Long-running endpoints that need a longer timeout:
  // - /scheduled-reports/test-email (60s) — builds report data + AI summary + email
  const isScheduledReportTestEmail = /\/scheduled-reports\/test-email$/.test(backendPath)

  // Also detect by the request's Accept header (EventSource always sends
  // text/event-stream; NDJSON consumers send application/x-ndjson).
  const requestAccept = (request.headers.get('accept') || '').toLowerCase()
  const isStreamRequest =
    isStreamEndpoint ||
    requestAccept.includes('text/event-stream') ||
    requestAccept.includes('application/x-ndjson')

  // Choose appropriate timeout
  let timeoutMs = 10_000
  if (isStreamRequest) {
    timeoutMs = 0 // no timeout for streams
  } else if (isScheduledReportTestEmail) {
    timeoutMs = 60_000 // 60s for test email (AI summary generation)
  }

  try {
    const search = request.nextUrl.search || ''
    const response = await fetch(`${buildBackendUrl(backendPath)}${search}`, {
      method: request.method,
      headers: buildBackendProxyHeaders(session, request.headers),
      body: await getProxyRequestBody(request),
      cache: 'no-store',
      // Stream endpoints: no timeout (let the connection close naturally when
      // the backend finishes or the client disconnects). Other endpoints:
      // 10s guard against runaway backend calls.
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
