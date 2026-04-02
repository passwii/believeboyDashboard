import { NextResponse } from 'next/server'

import { requireUserSession } from '@/lib/auth/server'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { getBackendApiKey, backendFetchJson } from '@/lib/server/backend-api'
import { getPromptPresetSummaries } from '@/lib/server/ai-chat'

export async function GET() {
  const session = await requireUserSession()
  if (!session) {
    return NextResponse.json({ message: 'Forbidden' }, { status: 403 })
  }

  const promptPresets = getPromptPresetSummaries()

  try {
    const apiKey = getBackendApiKey()
    if (!apiKey) {
      throw new Error('缺少后端 API Key 配置')
    }

    const payload = await backendFetchJson<{
      provider_configured: boolean
      web_search_configured: boolean
      models: string[]
      default_model: string
      timeout_seconds: number
    }>('/api/v1/ai/config', {
      method: 'GET',
      headers: { 'X-API-Key': apiKey },
      cache: 'no-store',
    })

    return NextResponse.json({
      providerConfigured: payload.provider_configured,
      webSearchConfigured: payload.web_search_configured,
      models: payload.models,
      defaultModel: payload.default_model,
      timeoutSeconds: payload.timeout_seconds,
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
        timeoutSeconds: 90,
        ...promptPresets,
      }
    )
  }
}
