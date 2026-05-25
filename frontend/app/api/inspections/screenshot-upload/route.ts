import { NextResponse } from 'next/server'

import { requireUserSession } from '@/lib/auth/server'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { getBackendApiKey, getBackendBaseUrl } from '@/lib/server/backend-api'

export async function POST(request: Request) {
  const session = await requireUserSession()
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const apiKey = getBackendApiKey()
  if (!apiKey) {
    return NextResponse.json({ error: '缺少后端 API Key 配置' }, { status: 500 })
  }

  // Forward the multipart body directly — same pattern as file-upload route
  const url = new URL(`${getBackendBaseUrl()}/api/v1/inspections/screenshots/upload`)
  const { searchParams } = new URL(request.url)
  url.search = searchParams.toString()

  try {
    const contentType = request.headers.get('content-type')
    const headers: Record<string, string> = {
      'X-API-Key': apiKey,
      'X-Operator': encodeURIComponent(session.user?.operatorNameZh || session.user?.name || ''),
      'X-User-Id': String(session.user?.id || ''),
      'X-Is-Admin': session.user?.roleType === 'admin' ? 'true' : 'false',
    }
    if (contentType) {
      headers['Content-Type'] = contentType
    }

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