import { backendFetchJson, getBackendApiKey } from '@/lib/server/backend-api'

export type PromptPresetSummary = {
  id: string
  label: string
  description: string
}

type PromptPreset = PromptPresetSummary & {
  content: string
}

type ProviderModel = {
  id: string
  object?: string
  owned_by?: string
}

const DEFAULT_TIMEOUT_SECONDS = 90

const OVERVIEW_PROMPT_PRESETS: PromptPreset[] = [
  {
    id: 'overview-standard',
    label: '总结总览·标准',
    description: '先给运营结论，再提炼关键变化和优先动作。',
    content:
      '回答时必须先输出一个标题为“总结总览”的部分，用 3-5 条要点先给出结论、关键变化、主要原因和最优先动作。',
  },
  {
    id: 'overview-concise',
    label: '总结总览·简洁',
    description: '用更短的管理视角总结当前判断。',
    content:
      '回答时必须先输出一个标题为“总结总览”的部分，用尽量精炼的语言概括现状判断、核心风险和立即建议。',
  },
]

const DETAIL_PROMPT_PRESETS: PromptPreset[] = [
  {
    id: 'detail-standard',
    label: '明细·标准',
    description: '补充原因分析、证据和落地建议。',
    content:
      '回答时还必须输出一个标题为“明细”的部分，展开说明原因拆解、关键证据、潜在风险和下一步建议。',
  },
  {
    id: 'detail-execution',
    label: '明细·执行版',
    description: '更强调动作、优先级和执行顺序。',
    content:
      '回答时还必须输出一个标题为“明细”的部分，并按“问题拆解 / 证据 / 执行动作 / 优先级”结构展开。',
  },
]

function trimTrailingSlash(value: string) {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

export function getAiProviderConfig() {
  const baseUrl = trimTrailingSlash(process.env.AI_CHAT_PROVIDER_BASE_URL || '')
  const apiKey = process.env.AI_CHAT_PROVIDER_API_KEY || ''
  const defaultModel = process.env.AI_CHAT_DEFAULT_MODEL || ''
  const timeoutSeconds = Number.parseInt(process.env.AI_CHAT_TIMEOUT_SECONDS || '', 10)

  return {
    baseUrl,
    apiKey,
    defaultModel,
    timeoutSeconds:
      Number.isFinite(timeoutSeconds) && timeoutSeconds >= 10 && timeoutSeconds <= 300
        ? timeoutSeconds
        : DEFAULT_TIMEOUT_SECONDS,
  }
}

export function isAiProviderConfigured() {
  const config = getAiProviderConfig()
  return Boolean(config.baseUrl && config.apiKey)
}

function getAllowedModelsFromEnv() {
  const allowList = (process.env.AI_CHAT_MODEL_ALLOWLIST || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

  return Array.from(new Set(allowList))
}

async function fetchModelsFromProvider(baseUrl: string, apiKey: string) {
  const response = await fetch(`${baseUrl}/models`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`模型列表获取失败 (${response.status}): ${detail.slice(0, 300)}`)
  }

  const payload = (await response.json()) as { data?: ProviderModel[] }
  const models = Array.isArray(payload.data) ? payload.data : []

  return models
    .map((item) => item.id?.trim())
    .filter((item): item is string => Boolean(item))
}

export async function resolveAvailableModels() {
  const config = getAiProviderConfig()
  const allowedModels = getAllowedModelsFromEnv()

  if (!config.baseUrl || !config.apiKey) {
    return {
      models: allowedModels.length > 0 ? allowedModels : config.defaultModel ? [config.defaultModel] : [],
      defaultModel: config.defaultModel,
    }
  }

  let models: string[] = []
  try {
    models = await fetchModelsFromProvider(config.baseUrl, config.apiKey)
  } catch {
    models = []
  }

  if (allowedModels.length > 0) {
    const remoteSet = new Set(models)
    const filtered = allowedModels.filter((model) => models.length === 0 || remoteSet.has(model))
    models = filtered.length > 0 ? filtered : allowedModels
  }

  if (models.length === 0 && config.defaultModel) {
    models = [config.defaultModel]
  }

  const uniqueModels = Array.from(new Set(models))
  const defaultModel =
    uniqueModels.find((item) => item === config.defaultModel) || uniqueModels[0] || config.defaultModel

  return {
    models: uniqueModels,
    defaultModel,
  }
}

export function getPromptPresetSummaries() {
  return {
    overviewOptions: OVERVIEW_PROMPT_PRESETS.map(({ id, label, description }) => ({ id, label, description })),
    detailOptions: DETAIL_PROMPT_PRESETS.map(({ id, label, description }) => ({ id, label, description })),
  }
}

function findPromptPreset(presets: PromptPreset[], id: string | null | undefined) {
  if (!id || id === 'none') {
    return null
  }
  return presets.find((item) => item.id === id) ?? null
}

export function buildSystemPrompt(overviewPromptId?: string | null, detailPromptId?: string | null) {
  const baseInstruction =
    '你是 BelieveBoy Dashboard 的运营数据助手，服务跨境电商运营团队。请使用中文输出，结论必须清晰、可执行，不要臆造不存在的数据。'

  const overviewPreset = findPromptPreset(OVERVIEW_PROMPT_PRESETS, overviewPromptId)
  const detailPreset = findPromptPreset(DETAIL_PROMPT_PRESETS, detailPromptId)

  const parts = [baseInstruction]
  if (overviewPreset) {
    parts.push(overviewPreset.content)
  }
  if (detailPreset) {
    parts.push(detailPreset.content)
  }

  return parts.join('\n\n')
}

export function validatePromptPresetIds(overviewPromptId?: string | null, detailPromptId?: string | null) {
  const overviewValid = !overviewPromptId || overviewPromptId === 'none' || Boolean(findPromptPreset(OVERVIEW_PROMPT_PRESETS, overviewPromptId))
  const detailValid = !detailPromptId || detailPromptId === 'none' || Boolean(findPromptPreset(DETAIL_PROMPT_PRESETS, detailPromptId))

  return overviewValid && detailValid
}

export function requireBackendApiKey() {
  const apiKey = getBackendApiKey()
  if (!apiKey) {
    throw new Error('缺少后端 API Key 配置')
  }
  return apiKey
}

export async function proxyBackendJson<T>(path: string, init?: RequestInit) {
  return backendFetchJson<T>(path, init)
}
