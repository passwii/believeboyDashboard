import { NextResponse } from 'next/server'

import { requireUserSession } from '@/lib/auth/server'
import { buildSystemPrompt, validatePromptPresetIds } from '@/lib/server/ai-chat'
import { getBackendApiKey, getBackendBaseUrl } from '@/lib/server/backend-api'

type RouteContext = {
  params: {
    conversationId: string
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  const session = await requireUserSession()
  if (!session) {
    return NextResponse.json({ message: 'Forbidden' }, { status: 403 })
  }

  const body = (await request.json()) as {
    content?: string
    model?: string
    regenerate?: boolean
    overviewPromptId?: string | null
    detailPromptId?: string | null
    enableWebSearch?: boolean
    attachedFileContent?: string | null
    attachedFileName?: string | null
  }

  if (!validatePromptPresetIds(body.overviewPromptId, body.detailPromptId)) {
    return NextResponse.json({ message: 'System Prompt 选项无效' }, { status: 400 })
  }

  const apiKey = getBackendApiKey()
  if (!apiKey) {
    return NextResponse.json({ message: '缺少后端 API Key 配置' }, { status: 500 })
  }

  const upstream = await fetch(`${getBackendBaseUrl()}/api/v1/ai/conversations/${params.conversationId}/messages/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
    body: JSON.stringify({
      content: body.content?.trim() || '',
      model: body.model?.trim() || undefined,
      regenerate: Boolean(body.regenerate),
      system_prompt: buildSystemPrompt(body.overviewPromptId, body.detailPromptId),
      enable_web_search: Boolean(body.enableWebSearch),
      attached_file_content: body.attachedFileContent?.trim() || null,
      attached_file_name: body.attachedFileName?.trim() || null,
    }),
    cache: 'no-store',
  })

  if (!upstream.ok) {
    const text = await upstream.text()
    return new Response(text, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      },
    })
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
    },
  })
}
