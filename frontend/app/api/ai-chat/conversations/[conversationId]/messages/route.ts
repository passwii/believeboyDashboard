import { NextResponse } from 'next/server'

import { requireUserSession } from '@/lib/auth/server'
import { normalizeErrorMessage } from '@/lib/error-utils'
import {
  buildSystemPrompt,
  getAiProviderConfig,
  proxyBackendJson,
  requireBackendApiKey,
  resolveAvailableModels,
  validatePromptPresetIds,
} from '@/lib/server/ai-chat'

type RouteContext = {
  params: {
    conversationId: string
  }
}

export async function GET(_request: Request, { params }: RouteContext) {
  const session = await requireUserSession()
  if (!session) {
    return NextResponse.json({ message: 'Forbidden' }, { status: 403 })
  }

  try {
    const apiKey = requireBackendApiKey()
    const data = await proxyBackendJson(`/api/v1/ai/conversations/${params.conversationId}/messages`, {
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
  const session = await requireUserSession()
  if (!session) {
    return NextResponse.json({ message: 'Forbidden' }, { status: 403 })
  }

  const body = (await request.json()) as {
    content?: string
    model?: string
    overviewPromptId?: string | null
    detailPromptId?: string | null
  }

  const content = body.content?.trim() || ''
  if (!content) {
    return NextResponse.json({ message: '消息内容不能为空' }, { status: 400 })
  }

  if (!validatePromptPresetIds(body.overviewPromptId, body.detailPromptId)) {
    return NextResponse.json({ message: 'System Prompt 选项无效' }, { status: 400 })
  }

  const providerConfig = getAiProviderConfig()
  if (!providerConfig.baseUrl || !providerConfig.apiKey) {
    return NextResponse.json({ message: 'AI Provider 未配置，请先在 .env.local 中设置' }, { status: 500 })
  }

  try {
    const { models, defaultModel } = await resolveAvailableModels()
    const selectedModel = body.model?.trim() || defaultModel

    if (!selectedModel) {
      return NextResponse.json({ message: '没有可用模型，请检查 .env.local 配置' }, { status: 500 })
    }

    if (models.length > 0 && !models.includes(selectedModel)) {
      return NextResponse.json({ message: '所选模型不在允许列表中' }, { status: 400 })
    }

    const apiKey = requireBackendApiKey()
    const data = await proxyBackendJson(`/api/v1/ai/conversations/${params.conversationId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
      },
      body: JSON.stringify({
        content,
        llm_config: {
          base_url: providerConfig.baseUrl,
          api_key: providerConfig.apiKey,
          model: selectedModel,
          timeout_seconds: providerConfig.timeoutSeconds,
          system_prompt: buildSystemPrompt(body.overviewPromptId, body.detailPromptId),
        },
      }),
      cache: 'no-store',
    })

    return NextResponse.json(data)
  } catch (err) {
    return NextResponse.json({ message: normalizeErrorMessage(err, '发送失败') }, { status: 500 })
  }
}
