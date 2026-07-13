export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'

import { requireAdminSession, requireUserSession } from '@/lib/auth/server'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { buildBackendProxyHeaders, buildBackendUrl } from '@/lib/server/backend-proxy'

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
          thumbnail_url: item.thumbnailUrl
            ? String(item.thumbnailUrl)
            : item.thumbnail_url
              ? String(item.thumbnail_url)
              : null,
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
      {
        success: false,
        error: normalizeErrorMessage(
          payload.error || payload.detail || payload.message,
          fallbackMessage
        ),
      },
      { status: response.status }
    )
  } catch {
    const text = await response.text()
    return NextResponse.json(
      { success: false, error: normalizeErrorMessage(text, fallbackMessage) },
      { status: response.status }
    )
  }
}

export async function GET(request: NextRequest) {
  const session = await requireUserSession()
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const params = new URLSearchParams(request.nextUrl.search)
    const backendParams = new URLSearchParams()
    const page = params.get('page')
    const pageSize = params.get('pageSize') ?? params.get('page_size')
    const currency = params.get('currency')
    const year = params.get('year')
    const month = params.get('month')
    const yearMonth = params.get('year_month')

    if (page) backendParams.set('page', page)
    if (pageSize) backendParams.set('page_size', pageSize)
    if (currency) backendParams.set('currency', currency)
    if (yearMonth) {
      backendParams.set('year_month', yearMonth)
    } else if (year && month) {
      backendParams.set('year_month', `${year}-${month.padStart(2, '0')}`)
    }

    const search = backendParams.toString()
    const response = await fetch(
      `${buildBackendUrl('api/v1/exchange-rates')}${search ? `?${search}` : ''}`,
      {
        method: 'GET',
        headers: buildBackendProxyHeaders(session, request.headers),
        cache: 'no-store',
      }
    )
    if (!response.ok) {
      return await toErrorResponse(response, 'Failed to fetch exchange rates')
    }

    const payload = (await response.json()) as {
      items: BackendExchangeRateItem[]
      total: number
      page: number
      page_size: number
    }
    return NextResponse.json({
      success: true,
      data: payload.items.map(toClientModel),
      pagination: {
        page: payload.page,
        pageSize: payload.page_size,
        total: payload.total,
        totalPages: Math.max(1, Math.ceil(payload.total / payload.page_size)),
      },
    })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: normalizeErrorMessage(error, '汇率列表加载失败') },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  const session = await requireAdminSession()
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const response = await fetch(buildBackendUrl('api/v1/exchange-rates'), {
      method: 'POST',
      headers: buildBackendProxyHeaders(session, request.headers),
      body: JSON.stringify(toBackendPayload(body)),
      cache: 'no-store',
    })
    if (!response.ok) {
      return await toErrorResponse(response, 'Failed to create exchange rate')
    }

    const payload = (await response.json()) as BackendExchangeRateItem
    return NextResponse.json({ success: true, data: toClientModel(payload) }, { status: 201 })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: normalizeErrorMessage(error, '汇率创建失败') },
      { status: 500 }
    )
  }
}
