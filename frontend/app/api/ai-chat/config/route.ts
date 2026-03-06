import { NextResponse } from 'next/server'

import { requireUserSession } from '@/lib/auth/server'
import {
  getAiProviderConfig,
  getPromptPresetSummaries,
  isAiProviderConfigured,
  resolveAvailableModels,
} from '@/lib/server/ai-chat'

export async function GET() {
  const session = await requireUserSession()
  if (!session) {
    return NextResponse.json({ message: 'Forbidden' }, { status: 403 })
  }

  const providerConfigured = isAiProviderConfigured()
  const providerConfig = getAiProviderConfig()
  const promptPresets = getPromptPresetSummaries()

  try {
    const { models, defaultModel } = await resolveAvailableModels()
    return NextResponse.json({
      providerConfigured,
      models,
      defaultModel,
      timeoutSeconds: providerConfig.timeoutSeconds,
      ...promptPresets,
    })
  } catch (err) {
    return NextResponse.json(
      {
        message: err instanceof Error ? err.message : '加载 AI 配置失败',
        providerConfigured,
        models: providerConfig.defaultModel ? [providerConfig.defaultModel] : [],
        defaultModel: providerConfig.defaultModel,
        timeoutSeconds: providerConfig.timeoutSeconds,
        ...promptPresets,
      }
    )
  }
}
