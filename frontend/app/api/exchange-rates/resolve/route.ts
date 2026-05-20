export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'

import { requireUserSession } from '@/lib/auth/server'
import { normalizeErrorMessage } from '@/lib/error-utils'
import {
  buildBackendProxyHeaders,
  buildBackendUrl,
} from '@/lib/server/backend-proxy'

async function toErrorResponse(response: Response, fallbackMessage: string) {
  try {
    const payload = (await response.json()) as { detail?: string; message?: string; error?: string }
    return NextResponse.json(
      { success: false, error: normalizeErrorMessage(payload.error || payload.detail || payload.message, fallbackMessage) },
      { status: response.status }
    )
  } catch {
    const text = await response.text()
    return NextResponse.json({ success: false, error: normalizeErrorMessage(text, fallbackMessage) }, { status: response.status })
  }
}

// GET /api/exchange-rates/resolve?currency=USD&year_month=2024-03
// Resolves exchange rate with fallback logic — for auto-fill in platform-revenue
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const currency = params.get('currency')
  const yearMonth = params.get('year_month')

  if (!currency || !yearMonth) {
    return NextResponse.json(
      { success: false, error: 'currency and year_month are required' },
      { status: 400 }
    )
  }

  const session = await requireUserSession()
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const query = new URLSearchParams({ currency: currency.toUpperCase(), year_month: yearMonth })

    const response = await fetch(`${buildBackendUrl('api/v1/exchange-rates/resolve')}?${query}`, {
      method: 'GET',
      headers: buildBackendProxyHeaders(session, request.headers),
      cache: 'no-store',
    })
    if (!response.ok) {
      return await toErrorResponse(response, 'Failed to resolve exchange rate')
    }

    const payload = await response.json()
    return NextResponse.json({ success: true, ...payload })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: normalizeErrorMessage(error, '汇率解析失败') },
      { status: 500 }
    )
  }
}