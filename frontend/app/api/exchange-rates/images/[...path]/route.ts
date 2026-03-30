export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'

import { requireUserSession } from '@/lib/auth/server'
import { normalizeErrorMessage } from '@/lib/error-utils'
import {
  buildBackendProxyHeaders,
  buildBackendUrl,
  toProxyResponse,
} from '@/lib/server/backend-proxy'

export async function GET(
  request: NextRequest,
  { params }: { params: { path: string[] } }
) {
  const session = await requireUserSession()
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const joinedPath = Array.isArray(params.path) ? params.path.join('/') : ''
  if (!joinedPath) {
    return NextResponse.json({ error: 'Invalid image path' }, { status: 400 })
  }

  try {
    const response = await fetch(buildBackendUrl(`api/v1/exchange-rates/images/${joinedPath}`), {
      method: 'GET',
      headers: buildBackendProxyHeaders(session, request.headers),
      cache: 'no-store',
    })
    return await toProxyResponse(response)
  } catch (error) {
    return NextResponse.json(
      { error: normalizeErrorMessage(error, '图片读取失败') },
      { status: 500 }
    )
  }
}
