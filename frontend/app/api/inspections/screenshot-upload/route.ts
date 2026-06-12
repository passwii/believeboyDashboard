import { NextResponse } from 'next/server'

import { requireUserSession } from '@/lib/auth/server'
import { buildBackendAuthHeaders, getBackendApiKeyOrFail } from '@/lib/backend-auth'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { getBackendBaseUrl } from '@/lib/server/backend-api'

export async function POST(request: Request) {
  const session = await requireUserSession()
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Forward the multipart body directly — same pattern as file-upload route.
  // The backend requires `X-API-Key` + session context, so build the header
  // record through `buildBackendAuthHeaders` (single source of truth shared
  // with the `/api/backend/...` proxy).
  const url = new URL(`${getBackendBaseUrl()}/api/v1/inspections/screenshots/upload`)
  const { searchParams } = new URL(request.url)
  url.search = searchParams.toString()

  const apiKeyOrResponse = getBackendApiKeyOrFail()
  if (apiKeyOrResponse.error) return apiKeyOrResponse.error

  const contentType = request.headers.get('content-type')
  try {
    const headers = buildBackendAuthHeaders(session, {
      apiKey: apiKeyOrResponse.apiKey,
      contentType: contentType ?? undefined,
    })

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: await request.arrayBuffer(),
    })

    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { detail?: string } | null
      return NextResponse.json(
        { error: normalizeErrorMessage(payload?.detail, '截图上传失败') },
        { status: response.status }
      )
    }

    return new Response(await response.arrayBuffer(), {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    return NextResponse.json(
      { error: normalizeErrorMessage(error, '截图上传失败') },
      { status: 500 }
    )
  }
}
