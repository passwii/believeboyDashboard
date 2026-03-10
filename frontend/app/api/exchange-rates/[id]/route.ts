export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'

import { requireAdminSession, requireUserSession } from '@/lib/auth/server'
import {
  buildBackendProxyHeaders,
  buildBackendUrl,
} from '@/lib/server/backend-proxy'

type BackendExchangeRateItem = {
  id: number
  currency: string
  currency_name?: string | null
  year_month: string
  rate: number
  description?: string | null
  note_images?: Array<{
    id: string
    url: string
    thumbnail_url?: string | null
    filename: string
    content_type: string
    size: number
    uploaded_at: string
  }> | null
  created_at: string
  updated_at: string
}

function toClientModel(rate: BackendExchangeRateItem) {
  const [yearText, monthText] = String(rate.year_month ?? '').split('-')
  const year = Number(yearText)
  const month = Number(monthText)
  return {
    id: rate.id,
    currency: rate.currency,
    currencyName: rate.currency_name || rate.currency,
    year: Number.isFinite(year) ? year : null,
    month: Number.isFinite(month) ? month : null,
    year_month: rate.year_month,
    rate: Number(rate.rate),
    description: rate.description ?? null,
    noteImages: Array.isArray(rate.note_images)
      ? rate.note_images.map((item) => ({
          id: item.id,
          url: item.url,
          thumbnailUrl: item.thumbnail_url ?? undefined,
          filename: item.filename,
          contentType: item.content_type,
          size: Number(item.size || 0),
          uploadedAt: item.uploaded_at,
        }))
      : [],
    createdAt: rate.created_at,
    updatedAt: rate.updated_at,
  }
}

function toBackendPayload(body: any) {
  return {
    currency: body.currency,
    currency_name: body.currencyName ?? body.currency_name ?? null,
    year_month: body.year_month ?? null,
    year: body.year ?? null,
    month: body.month ?? null,
    rate: body.rate === '' || body.rate == null ? null : Number(body.rate),
    description: body.description ?? null,
    note_images: Array.isArray(body.noteImages ?? body.note_images)
      ? (body.noteImages ?? body.note_images).map((item: any) => ({
          id: String(item.id || ''),
          url: String(item.url || ''),
          thumbnail_url: item.thumbnailUrl ? String(item.thumbnailUrl) : item.thumbnail_url ? String(item.thumbnail_url) : null,
          filename: String(item.filename || ''),
          content_type: String(item.contentType || item.content_type || ''),
          size: Number(item.size || 0),
          uploaded_at: String(item.uploadedAt || item.uploaded_at || ''),
        }))
      : [],
  }
}

async function toErrorResponse(response: Response, fallbackMessage: string) {
  try {
    const payload = (await response.json()) as { detail?: string; message?: string; error?: string }
    return NextResponse.json(
      { error: payload.error || payload.detail || payload.message || fallbackMessage },
      { status: response.status }
    )
  } catch {
    const text = await response.text()
    return NextResponse.json({ error: text || fallbackMessage }, { status: response.status })
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await requireUserSession()
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const id = Number(params.id)
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: 'Invalid ID' }, { status: 400 })
  }

  try {
    const response = await fetch(buildBackendUrl(`api/v1/exchange-rates/${id}`), {
      method: 'GET',
      headers: buildBackendProxyHeaders(session, request.headers),
      cache: 'no-store',
    })
    if (!response.ok) {
      return await toErrorResponse(response, 'Failed to fetch exchange rate')
    }

    const payload = (await response.json()) as BackendExchangeRateItem
    return NextResponse.json({ data: toClientModel(payload) })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch exchange rate' },
      { status: 500 }
    )
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await requireAdminSession()
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const id = Number(params.id)
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: 'Invalid ID' }, { status: 400 })
  }

  try {
    const body = await request.json()
    const response = await fetch(buildBackendUrl(`api/v1/exchange-rates/${id}`), {
      method: 'PUT',
      headers: buildBackendProxyHeaders(session, request.headers),
      body: JSON.stringify(toBackendPayload(body)),
      cache: 'no-store',
    })
    if (!response.ok) {
      return await toErrorResponse(response, 'Failed to update exchange rate')
    }

    const payload = (await response.json()) as BackendExchangeRateItem
    return NextResponse.json({ data: toClientModel(payload) })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update exchange rate' },
      { status: 500 }
    )
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await requireAdminSession()
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const id = Number(params.id)
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: 'Invalid ID' }, { status: 400 })
  }

  try {
    const response = await fetch(buildBackendUrl(`api/v1/exchange-rates/${id}`), {
      method: 'DELETE',
      headers: buildBackendProxyHeaders(session, request.headers),
      cache: 'no-store',
    })
    if (!response.ok) {
      return await toErrorResponse(response, 'Failed to delete exchange rate')
    }
    return NextResponse.json({ success: true })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete exchange rate' },
      { status: 500 }
    )
  }
}
