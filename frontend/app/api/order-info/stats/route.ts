export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'

import { requireUserSession } from '@/lib/auth/server'
import { normalizeErrorMessage } from '@/lib/error-utils'
import {
  buildBackendProxyHeaders,
  buildBackendUrl,
} from '@/lib/server/backend-proxy'

/**
 * GET /api/order-info/stats
 *
 * 反向代理到后端 /api/v1/order-info/stats
 */

function buildBackendParams(request: NextRequest): URLSearchParams {
  const params = new URLSearchParams()
  const search = new URLSearchParams(request.nextUrl.search)

  const passList = (key: string) => {
    const all = search.getAll(key)
    for (const value of all) {
      if (value) params.append(key, value)
    }
  }

  // 多值：project_ids, fulfillment_channels, order_statuses, countries, currencies
  passList('project_ids')
  passList('fulfillment_channels')
  passList('order_statuses')
  passList('countries')
  passList('currencies')

  const passString = (key: string) => {
    const v = search.get(key)
    if (v != null && v !== '') params.set(key, v)
  }

  passString('sku_keyword')
  passString('order_id_keyword')
  passString('orderIdKeyword')
  passString('asin_keyword')
  passString('date_from')
  passString('date_to')

  return params
}

export async function GET(request: NextRequest) {
  const session = await requireUserSession()
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const params = buildBackendParams(request)
    const query = params.toString()
    const url = buildBackendUrl(`api/v1/order-info/stats${query ? `?${query}` : ''}`)

    const response = await fetch(url, {
      method: 'GET',
      headers: buildBackendProxyHeaders(session, request.headers),
      cache: 'no-store',
    })
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { detail?: string; message?: string } | null
      return NextResponse.json(
        { error: normalizeErrorMessage(payload?.detail || payload?.message, '统计加载失败') },
        { status: response.status }
      )
    }

    const payload = await response.json()
    return NextResponse.json(payload)
  } catch (error) {
    return NextResponse.json(
      { error: normalizeErrorMessage(error, '统计加载失败') },
      { status: 500 }
    )
  }
}