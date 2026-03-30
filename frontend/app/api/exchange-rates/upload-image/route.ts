export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'

import { requireAdminSession } from '@/lib/auth/server'
import { normalizeErrorMessage } from '@/lib/error-utils'
import {
  buildBackendProxyHeaders,
  buildBackendUrl,
} from '@/lib/server/backend-proxy'

export async function POST(request: Request) {
  const session = await requireAdminSession()
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const response = await fetch(buildBackendUrl('api/v1/exchange-rates/upload-image'), {
      method: 'POST',
      headers: buildBackendProxyHeaders(session, request.headers),
      body: await request.arrayBuffer(),
      cache: 'no-store',
    })
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { detail?: string; message?: string } | null
      return NextResponse.json(
        { error: normalizeErrorMessage(payload?.detail || payload?.message, '图片上传失败') },
        { status: response.status }
      )
    }

    const payload = (await response.json()) as {
      id: string
      url: string
      thumbnail_url?: string | null
      filename: string
      content_type: string
      size: number
      uploaded_at: string
    }

    return NextResponse.json({
      success: true,
      data: {
        id: payload.id,
        url: payload.url,
        thumbnailUrl: payload.thumbnail_url ?? undefined,
        filename: payload.filename,
        contentType: payload.content_type,
        size: payload.size,
        uploadedAt: payload.uploaded_at,
      },
    })
  } catch (error) {
    return NextResponse.json(
      { error: normalizeErrorMessage(error, '图片上传失败') },
      { status: 500 }
    )
  }
}
