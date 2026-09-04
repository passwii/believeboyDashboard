import { NextResponse } from 'next/server'

import { requireUserSession } from '@/lib/auth/server'
import { buildBackendAuthHeaders, getBackendApiKeyOrFail } from '@/lib/backend-auth'
import {
  buildSystemPrompt,
  validatePromptPresetIds,
  buildScenarioSystemPrompt,
  validateScenarioIds,
} from '@/lib/server/ai-chat'
import { appendApiKeyQuery, getBackendBaseUrl } from '@/lib/server/backend-api'

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
    scenarioId?: string | null
    toneId?: string | null
    language?: string | null
    length?: string | null
    enableWebSearch?: boolean
    attachedFileContent?: string | null
    attachedFileName?: string | null
  }

  if (!validatePromptPresetIds(body.overviewPromptId, body.detailPromptId)) {
    return NextResponse.json({ message: 'System Prompt 选项无效' }, { status: 400 })
  }

  if (!validateScenarioIds(body.scenarioId, body.toneId)) {
    return NextResponse.json({ message: '场景或语气选项无效' }, { status: 400 })
  }

  const upstreamHeaders = buildBackendAuthHeaders(session, {
    apiKey: apiKeyOrResponse.apiKey,
    contentType: 'application/json',
    accept: 'text/event-stream',
  })
  // V2 重连：把客户端的 Last-Event-ID 透传给后端，从该 ID 之后续传。
  const lastEventId = request.headers.get('Last-Event-ID')
  if (lastEventId) upstreamHeaders.set('Last-Event-ID', lastEventId)

  const upstream = await fetch(
    `${getBackendBaseUrl()}${appendApiKeyQuery(`/api/v1/ai/conversations/${conversationId}/messages/stream`)}`,
    {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify({
        content: body.content?.trim() || '',
        model: body.model?.trim() || undefined,
        reasoning_effort: body.reasoningEffort?.trim() || null,
        regenerate: Boolean(body.regenerate),
        target_message_id: body.target_message_id ?? null,
        system_prompt: body.scenarioId
          ? buildScenarioSystemPrompt(body.scenarioId, body.toneId, body.language, body.length)
          : buildSystemPrompt(body.overviewPromptId, body.detailPromptId),
        enable_web_search: Boolean(body.enableWebSearch),
        attached_file_content: body.attachedFileContent?.trim() || null,
        attached_file_name: body.attachedFileName?.trim() || null,
      }),
      cache: 'no-store',
    }
  )

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
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  })
}
