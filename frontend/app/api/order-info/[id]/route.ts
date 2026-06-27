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
 * PATCH /api/order-info/[id]
 *
 * 反向代理到后端 /api/v1/order-info/{id}
 * 用于 FBM 订单补录（carrier / tracking_no / shipped_at / updated_by）。
 */

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireUserSession()
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params
  const orderId = Number(id)
  if (!Number.isFinite(orderId) || orderId <= 0) {
    return NextResponse.json({ error: 'Invalid order id' }, { status: 400 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  try {
    const url = buildBackendUrl(`api/v1/order-info/${orderId}`)
    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        ...buildBackendProxyHeaders(session, request.headers),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      cache: 'no-store',
    })

    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as
        | { detail?: string; message?: string }
        | null
      return NextResponse.json(
        {
          error: normalizeErrorMessage(
            payload?.detail || payload?.message,
            '更新订单失败'
          ),
        },
        { status: response.status }
      )
    }

    const payload = await response.json()
    return NextResponse.json(payload)
  } catch (error) {
    return NextResponse.json(
      { error: normalizeErrorMessage(error, '更新订单失败') },
      { status: 500 }
    )
  }
}