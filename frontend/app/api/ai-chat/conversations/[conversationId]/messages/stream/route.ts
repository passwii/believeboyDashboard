import { NextResponse } from 'next/server'

import { requireUserSession } from '@/lib/auth/server'
import { buildBackendAuthHeaders, getBackendApiKeyOrFail } from '@/lib/backend-auth'
import { buildSystemPrompt, validatePromptPresetIds } from '@/lib/server/ai-chat'
import { getBackendBaseUrl } from '@/lib/server/backend-api'

type RouteContext = {
  params: Promise<{
    conversationId: string
  }>
}

export async function POST(request: Request, { params }: RouteContext) {
  const { conversationId } = await params
  const session = await requireUserSession()
  if (!session) {
    return NextResponse.json({ message: 'Forbidden' }, { status: 403 })
  }

  const apiKeyOrResponse = getBackendApiKeyOrFail()
  if (apiKeyOrResponse.error) return apiKeyOrResponse.error

  const body = (await request.json()) as {
    content?: string
    model?: string
    reasoningEffort?: string | null
    regenerate?: boolean
    target_message_id?: number
    overviewPromptId?: string | null
    detailPromptId?: string | null
    enableWebSearch?: boolean
    attachedFileContent?: string | null
    attachedFileName?: string | null
  }

  if (!validatePromptPresetIds(body.overviewPromptId, body.detailPromptId)) {
    return NextResponse.json({ message: 'System Prompt 选项无效' }, { status: 400 })
  }

  const upstream = await fetch(`${getBackendBaseUrl()}/api/v1/ai/conversations/${conversationId}/messages/stream`, {
    method: 'POST',
    headers: buildBackendAuthHeaders(session, {
      apiKey: apiKeyOrResponse.apiKey,
      contentType: 'application/json',
    }),
    body: JSON.stringify({
      content: body.content?.trim() || '',
      model: body.model?.trim() || undefined,
      reasoning_effort: body.reasoningEffort?.trim() || null,
      regenerate: Boolean(body.regenerate),
      target_message_id: body.target_message_id ?? null,
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
