import { NextResponse } from 'next/server'

import { requireUserSession } from '@/lib/auth/server'
import { buildBackendAuthHeaders, getBackendApiKeyOrFail } from '@/lib/backend-auth'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { backendFetchJson } from '@/lib/server/backend-api'
import { getPromptPresetSummaries } from '@/lib/server/ai-chat'

export async function GET() {
  const session = await requireUserSession()
  if (!session) {
    return NextResponse.json({ message: 'Forbidden' }, { status: 403 })
  }

  const promptPresets = getPromptPresetSummaries()

  const apiKeyOrResponse = getBackendApiKeyOrFail()
  if (apiKeyOrResponse.error) {
    return NextResponse.json(
      {
        message: '缺少后端 API Key 配置',
        providerConfigured: false,
        webSearchConfigured: false,
        models: [],
        defaultModel: '',
        premiumModels: [],
        basicModels: [],
        reasoningModels: [],
        defaultReasoningEffort: 'medium',
        timeoutSeconds: 90,
        maxConversationTurns: 10,
        webSearchMaxResults: 5,
        ...promptPresets,
      },
      { status: 500 }
    )
  }

  try {
    const payload = await backendFetchJson<{
      provider_configured: boolean
      web_search_configured: boolean
      models: string[]
      default_model: string
      premium_models: string[]
      basic_models: string[]
      reasoning_models: string[]
      default_reasoning_effort: string
      timeout_seconds: number
      max_conversation_turns: number
      web_search_max_results: number
    }>('/api/v1/ai/config', {
      method: 'GET',
      headers: buildBackendAuthHeaders(session, { apiKey: apiKeyOrResponse.apiKey }),
      cache: 'no-store',
    })

    return NextResponse.json({
      providerConfigured: payload.provider_configured,
      webSearchConfigured: payload.web_search_configured,
      models: payload.models,
      defaultModel: payload.default_model,
      premiumModels: payload.premium_models,
      basicModels: payload.basic_models,
      reasoningModels: payload.reasoning_models,
      defaultReasoningEffort: payload.default_reasoning_effort,
      timeoutSeconds: payload.timeout_seconds,
      maxConversationTurns: payload.max_conversation_turns,
      webSearchMaxResults: payload.web_search_max_results,
      ...promptPresets,
    })
  } catch (err) {
    return NextResponse.json(
      {
        message: normalizeErrorMessage(err, '加载 AI 配置失败'),
        providerConfigured: false,
        webSearchConfigured: false,
        models: [],
        defaultModel: '',
        premiumModels: [],
        basicModels: [],
        reasoningModels: [],
        defaultReasoningEffort: 'medium',
        timeoutSeconds: 90,
        maxConversationTurns: 10,
        webSearchMaxResults: 5,
        ...promptPresets,
      }
    )
  }
}
