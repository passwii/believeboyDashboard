import { NextResponse } from 'next/server'

import { requireUserSession } from '@/lib/auth/server'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { getBackendApiKey, getBackendBaseUrl } from '@/lib/server/backend-api'

type RouteContext = {
  params: {
    conversationId: string
  }
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  const session = await requireUserSession()
  if (!session) {
    return NextResponse.json({ message: 'Forbidden' }, { status: 403 })
  }

  try {
    const apiKey = getBackendApiKey()
    if (!apiKey) {
      throw new Error('缺少后端 API Key 配置')
    }

    const upstream = await fetch(`${getBackendBaseUrl()}/api/v1/ai/conversations/${params.conversationId}`, {
      method: 'DELETE',
      headers: { 'X-API-Key': apiKey },
      cache: 'no-store',
    })
    if (!upstream.ok) {
      const text = await upstream.text()
      throw new Error(text || '删除会话失败')
    }
    return new NextResponse(null, { status: 204 })
  } catch (err) {
    return NextResponse.json({ message: normalizeErrorMessage(err, '删除会话失败') }, { status: 500 })
  }
}

export async function POST(_request: Request, { params }: RouteContext) {
  const session = await requireUserSession()
  if (!session) {
    return NextResponse.json({ message: 'Forbidden' }, { status: 403 })
  }

  try {
    const apiKey = getBackendApiKey()
    if (!apiKey) {
      throw new Error('缺少后端 API Key 配置')
    }

    const upstream = await fetch(`${getBackendBaseUrl()}/api/v1/ai/conversations/${params.conversationId}/regenerate-title`, {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      cache: 'no-store',
    })
    const data = await upstream.json()
    if (!upstream.ok) {
      throw new Error(String((data as { message?: string; detail?: string }).message || (data as { detail?: string }).detail || '重生成标题失败'))
    }
    return NextResponse.json(data)
  } catch (err) {
    return NextResponse.json({ message: normalizeErrorMessage(err, '重生成标题失败') }, { status: 500 })
  }
}
