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

async function proxy(request: NextRequest, { params }: { params: { path: string[] } }) {
  const session = await requireUserSession()
  if (!session) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 })
  }

  const joinedPath = Array.isArray(params.path) ? params.path.join('/') : ''
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

  try {
    const search = request.nextUrl.search || ''
    const response = await fetch(`${buildBackendUrl(backendPath)}${search}`, {
      method: request.method,
      headers: buildBackendProxyHeaders(session, request.headers),
      body: await getProxyRequestBody(request),
      cache: 'no-store',
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
