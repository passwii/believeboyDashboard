import { NextResponse } from 'next/server'

import { requireUserSession } from '@/lib/auth/server'
import { buildBackendAuthHeaders } from '@/lib/backend-auth'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { backendFetchJson, getBackendApiKey } from '@/lib/server/backend-api'

export async function GET() {
  const session = await requireUserSession()
  if (!session) {
    return NextResponse.json({ message: 'Forbidden' }, { status: 403 })
  }

  try {
    const data = await backendFetchJson('/api/v1/ai/conversations', {
      method: 'GET',
      headers: buildBackendAuthHeaders(session, { apiKey: getBackendApiKey() }),
      cache: 'no-store',
    })
    return NextResponse.json(data)
  } catch (err) {
    return NextResponse.json({ message: normalizeErrorMessage(err, '加载会话失败') }, { status: 500 })
  }
}

export async function POST(request: Request) {
  const session = await requireUserSession()
  if (!session) {
    return NextResponse.json({ message: 'Forbidden' }, { status: 403 })
  }

  const body = (await request.json()) as { title?: string }

  try {
    const data = await backendFetchJson('/api/v1/ai/conversations', {
      method: 'POST',
      headers: buildBackendAuthHeaders(session, {
        apiKey: getBackendApiKey(),
        contentType: 'application/json',
      }),
      body: JSON.stringify({ title: body.title }),
      cache: 'no-store',
    })
    return NextResponse.json(data, { status: 201 })
  } catch (err) {
    return NextResponse.json({ message: normalizeErrorMessage(err, '创建会话失败') }, { status: 500 })
  }
}
