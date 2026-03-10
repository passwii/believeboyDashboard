export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'

import { requireUserSession } from '@/lib/auth/server'
import {
  buildBackendProxyHeaders,
  buildBackendUrl,
} from '@/lib/server/backend-proxy'

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
      const payload = (await response.json().catch(() => null)) as { detail?: string; message?: string } | null
      return NextResponse.json(
        { error: payload?.detail || payload?.message || 'Failed to fetch options' },
        { status: response.status }
      )
    }

    const payload = await response.json()
    return NextResponse.json(payload)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch options' },
      { status: 500 }
    )
  }
}
