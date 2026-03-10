export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'

import { requireUserSession } from '@/lib/auth/server'
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

  try {
    const search = request.nextUrl.search || ''
    const response = await fetch(`${buildBackendUrl(joinedPath)}${search}`, {
      method: request.method,
      headers: buildBackendProxyHeaders(session, request.headers),
      body: await getProxyRequestBody(request),
      cache: 'no-store',
    })
    return await toProxyResponse(response)
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : 'Proxy request failed' },
      { status: 500 }
    )
  }
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE }
