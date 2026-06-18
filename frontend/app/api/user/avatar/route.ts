import { NextResponse } from 'next/server'

import { requireUserSession } from '@/lib/auth/server'
import { buildBackendAuthHeaders, getBackendApiKeyOrFail } from '@/lib/backend-auth'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { backendFetchJson } from '@/lib/server/backend-api'

export async function POST(request: Request) {
  const session = await requireUserSession()
  if (!session?.user?.id) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 })
  }

  const apiKeyOrResponse = getBackendApiKeyOrFail()
  if (apiKeyOrResponse.error) return apiKeyOrResponse.error

  // Re-pack the multipart body so we can carry the original filename +
  // content-type forward — ``request.formData()`` consumes the stream and
  // we lose the boundary when we re-serialise. Reassembling from the raw
  // body keeps the multipart envelope intact.
  const contentType = request.headers.get('content-type') || ''
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    return NextResponse.json(
      { message: '请求必须是 multipart/form-data' },
      { status: 400 },
    )
  }

  try {
    const body = await request.arrayBuffer()
    const forwarded = await backendFetchJson<{
      avatar_url: string
      size: number
      content_type: string
    }>('/api/v1/system-management/profile/avatar', {
      method: 'POST',
      headers: buildBackendAuthHeaders(session, {
        apiKey: apiKeyOrResponse.apiKey,
        // Do NOT set Content-Type — fetch will populate it with the
        // correct multipart boundary when given a Buffer body.
      }),
      body,
      cache: 'no-store',
    })
    return NextResponse.json(forwarded)
  } catch (err) {
    return NextResponse.json(
      { message: normalizeErrorMessage(err, '头像上传失败') },
      { status: 500 },
    )
  }
}

export async function DELETE() {
  const session = await requireUserSession()
  if (!session?.user?.id) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 })
  }

  const apiKeyOrResponse = getBackendApiKeyOrFail()
  if (apiKeyOrResponse.error) return apiKeyOrResponse.error

  try {
    const result = await backendFetchJson<{ ok: boolean }>(
      '/api/v1/system-management/profile/avatar',
      {
        method: 'DELETE',
        headers: buildBackendAuthHeaders(session, {
          apiKey: apiKeyOrResponse.apiKey,
          accept: 'application/json',
        }),
        cache: 'no-store',
      },
    )
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json(
      { message: normalizeErrorMessage(err, '删除头像失败') },
      { status: 500 },
    )
  }
}