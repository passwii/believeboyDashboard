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
 * POST /api/order-info/export
 *
 * 反向代理到后端 /api/v1/order-info/export，下载 CSV。
 */

function buildPayload(body: Record<string, unknown>) {
  return {
    project_ids: Array.isArray(body.project_ids) ? body.project_ids : [],
    fulfillment_channels: Array.isArray(body.fulfillment_channels) ? body.fulfillment_channels : [],
    order_statuses: Array.isArray(body.order_statuses) ? body.order_statuses : [],
    countries: Array.isArray(body.countries) ? body.countries : [],
    currencies: Array.isArray(body.currencies) ? body.currencies : [],
    sku_keyword: body.sku_keyword ?? null,
    order_id_keyword: body.order_id_keyword ?? body.orderIdKeyword ?? null,
    asin_keyword: body.asin_keyword ?? null,
    date_from: body.date_from ?? null,
    date_to: body.date_to ?? null,
  }
}

export async function POST(request: NextRequest) {
  const session = await requireUserSession()
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: Record<string, unknown> = {}
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    body = {}
  }

  try {
    const response = await fetch(buildBackendUrl('api/v1/order-info/export'), {
      method: 'POST',
      headers: buildBackendProxyHeaders(session, request.headers, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(buildPayload(body)),
      cache: 'no-store',
    })
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { detail?: string; message?: string } | null
      return NextResponse.json(
        { error: normalizeErrorMessage(payload?.detail || payload?.message, '导出失败') },
        { status: response.status }
      )
    }

    const payload = await response.json()
    return NextResponse.json(payload)
  } catch (error) {
    return NextResponse.json(
      { error: normalizeErrorMessage(error, '导出失败') },
      { status: 500 }
    )
  }
}