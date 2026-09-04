import { NextResponse } from 'next/server'

import { requireUserSession } from '@/lib/auth/server'
import { buildBackendAuthHeaders, getBackendApiKeyOrFail } from '@/lib/backend-auth'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { getBackendBaseUrl } from '@/lib/server/backend-api'

type RouteContext = {
  params: Promise<{
    conversationId: string
  }>
}

export async function PATCH(request: Request, { params }: RouteContext) {
  const { conversationId } = await params
  const session = await requireUserSession()
  if (!session) {
    return NextResponse.json({ message: 'Forbidden' }, { status: 403 })
  }

  const apiKeyOrResponse = getBackendApiKeyOrFail()
  if (apiKeyOrResponse.error) return apiKeyOrResponse.error

  try {
    const body = await request.json()
    const upstream = await fetch(
      `${getBackendBaseUrl()}/api/v1/ai/conversations/${conversationId}`,
      {
        method: 'PATCH',
        headers: buildBackendAuthHeaders(session, {
          apiKey: apiKeyOrResponse.apiKey,
          contentType: 'application/json',
        }),
        body: JSON.stringify(body),
        cache: 'no-store',
      }
    )
    if (!upstream.ok) {
      const text = await upstream.text()
      throw new Error(text || '更新会话失败')
    }
    return NextResponse.json(await upstream.json())
  } catch (err) {
    return NextResponse.json(
      { message: normalizeErrorMessage(err, '更新会话失败') },
      { status: 500 }
    )
  }
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  const { conversationId } = await params
  const session = await requireUserSession()
  if (!session) {
    return NextResponse.json({ message: 'Forbidden' }, { status: 403 })
  }

  const apiKeyOrResponse = getBackendApiKeyOrFail()
  if (apiKeyOrResponse.error) return apiKeyOrResponse.error

  try {
    const upstream = await fetch(
      `${getBackendBaseUrl()}/api/v1/ai/conversations/${conversationId}`,
      {
        method: 'DELETE',
        headers: buildBackendAuthHeaders(session, { apiKey: apiKeyOrResponse.apiKey }),
        cache: 'no-store',
      }
    )
    if (!upstream.ok) {
      const text = await upstream.text()
      throw new Error(text || '删除会话失败')
    }
    return new NextResponse(null, { status: 204 })
  } catch (err) {
    return NextResponse.json(
      { message: normalizeErrorMessage(err, '删除会话失败') },
      { status: 500 }
    )
  }
}

export async function POST(_request: Request, { params }: RouteContext) {
  const { conversationId } = await params
  const session = await requireUserSession()
  if (!session) {
    return NextResponse.json({ message: 'Forbidden' }, { status: 403 })
  }

  const apiKeyOrResponse = getBackendApiKeyOrFail()
  if (apiKeyOrResponse.error) return apiKeyOrResponse.error

  try {
    const upstream = await fetch(
      `${getBackendBaseUrl()}/api/v1/ai/conversations/${conversationId}/regenerate-title`,
      {
        method: 'POST',
        headers: buildBackendAuthHeaders(session, { apiKey: apiKeyOrResponse.apiKey }),
        cache: 'no-store',
      }
    )
    const data = await upstream.json()
    if (!upstream.ok) {
      throw new Error(
        String(
          (data as { message?: string; detail?: string }).message ||
            (data as { detail?: string }).detail ||
            '重生成标题失败'
        )
      )
    }
    return NextResponse.json(data)
  } catch (err) {
    return NextResponse.json(
      { message: normalizeErrorMessage(err, '重生成标题失败') },
      { status: 500 }
    )
  }
}
