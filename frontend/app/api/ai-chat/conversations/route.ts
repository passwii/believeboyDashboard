import { NextResponse } from 'next/server'

import { requireUserSession } from '@/lib/auth/server'
import { buildBackendAuthHeaders, getBackendApiKeyOrFail } from '@/lib/backend-auth'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { backendFetchJson } from '@/lib/server/backend-api'

export async function GET() {
  const session = await requireUserSession()
  if (!session) {
    return NextResponse.json({ message: 'Forbidden' }, { status: 403 })
  }

  const apiKeyOrResponse = getBackendApiKeyOrFail()
  if (apiKeyOrResponse.error) return apiKeyOrResponse.error

  try {
    const data = await backendFetchJson('/api/v1/ai/conversations', {
      method: 'GET',
      headers: buildBackendAuthHeaders(session, { apiKey: apiKeyOrResponse.apiKey }),
      cache: 'no-store',
    })
    return NextResponse.json(data)
  } catch (err) {
    return NextResponse.json(
      { message: normalizeErrorMessage(err, '加载会话失败') },
      { status: 500 }
    )
  }
}

export async function POST(request: Request) {
  const session = await requireUserSession()
  if (!session) {
    return NextResponse.json({ message: 'Forbidden' }, { status: 403 })
  }

  const apiKeyOrResponse = getBackendApiKeyOrFail()
  if (apiKeyOrResponse.error) return apiKeyOrResponse.error

  const body = (await request.json()) as { title?: string }

  try {
    const data = await backendFetchJson('/api/v1/ai/conversations', {
      method: 'POST',
      headers: buildBackendAuthHeaders(session, {
        apiKey: apiKeyOrResponse.apiKey,
        contentType: 'application/json',
      }),
      body: JSON.stringify({ title: body.title }),
      cache: 'no-store',
    })
    return NextResponse.json(data, { status: 201 })
  } catch (err) {
    return NextResponse.json(
      { message: normalizeErrorMessage(err, '创建会话失败') },
      { status: 500 }
    )
  }
}
