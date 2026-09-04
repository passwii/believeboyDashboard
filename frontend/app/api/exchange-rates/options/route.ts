export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'

import { requireUserSession } from '@/lib/auth/server'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { buildBackendProxyHeaders, buildBackendUrl } from '@/lib/server/backend-proxy'

export async function GET(request: NextRequest) {
  const session = await requireUserSession()
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const response = await fetch(buildBackendUrl('api/v1/exchange-rates/options'), {
      method: 'GET',
      headers: buildBackendProxyHeaders(session, request.headers),
      cache: 'no-store',
    })
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        detail?: string
        message?: string
      } | null
      return NextResponse.json(
        { error: normalizeErrorMessage(payload?.detail || payload?.message, '汇率选项加载失败') },
        { status: response.status }
      )
    }

    const payload = await response.json()
    return NextResponse.json(payload)
  } catch (error) {
    return NextResponse.json(
      { error: normalizeErrorMessage(error, '汇率选项加载失败') },
      { status: 500 }
    )
  }
}
