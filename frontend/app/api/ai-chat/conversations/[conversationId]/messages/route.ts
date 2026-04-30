import { NextResponse } from 'next/server'

import { requireUserSession } from '@/lib/auth/server'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { backendFetchJson, getBackendApiKey } from '@/lib/server/backend-api'
import { buildSystemPrompt, validatePromptPresetIds } from '@/lib/server/ai-chat'

type RouteContext = {
  params: Promise<{
    conversationId: string
  }>
}

export async function GET(_request: Request, { params }: RouteContext) {
  const { conversationId } = await params
  const session = await requireUserSession()
  if (!session) {
    return NextResponse.json({ message: 'Forbidden' }, { status: 403 })
  }

  try {
    const apiKey = getBackendApiKey()
    if (!apiKey) {
      throw new Error('缺少后端 API Key 配置')
    }

    const data = await backendFetchJson(`/api/v1/ai/conversations/${conversationId}/messages`, {
      method: 'GET',
      headers: { 'X-API-Key': apiKey },
      cache: 'no-store',
    })
    return NextResponse.json(data)
  } catch (err) {
    return NextResponse.json({ message: normalizeErrorMessage(err, '加载消息失败') }, { status: 500 })
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  const { conversationId } = await params
  const session = await requireUserSession()
  if (!session) {
    return NextResponse.json({ message: 'Forbidden' }, { status: 403 })
  }

  const body = (await request.json()) as {
    content?: string
    model?: string
    overviewPromptId?: string | null
    detailPromptId?: string | null
    enableWebSearch?: boolean
  }

  const content = body.content?.trim() || ''
  if (!content) {
    return NextResponse.json({ message: '消息内容不能为空' }, { status: 400 })
  }

  if (!validatePromptPresetIds(body.overviewPromptId, body.detailPromptId)) {
    return NextResponse.json({ message: 'System Prompt 选项无效' }, { status: 400 })
  }

  try {
    const apiKey = getBackendApiKey()
    if (!apiKey) {
      throw new Error('缺少后端 API Key 配置')
    }

    const data = await backendFetchJson(`/api/v1/ai/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
      },
      body: JSON.stringify({
        content,
        model: body.model?.trim() || undefined,
        system_prompt: buildSystemPrompt(body.overviewPromptId, body.detailPromptId),
        enable_web_search: Boolean(body.enableWebSearch),
      }),
      cache: 'no-store',
    })

    return NextResponse.json(data)
  } catch (err) {
    return NextResponse.json({ message: normalizeErrorMessage(err, '发送失败') }, { status: 500 })
  }
}
