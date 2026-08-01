/**
 * AI Chat 配置兜底（degraded）payload 的单一事实源。
 *
 * `app/api/ai-chat/config/route.ts` 在后端不可用 / 缺少 API Key 时返回兜底配置。
 * 此前该兜底对象在 route 里被复制了两份（缺 Key 分支 + catch 分支），数值默认值
 * 靠手抄与后端 pydantic 保持一致 —— 典型的漂移隐患。这里抽成单一模块：
 *
 * - `AI_CHAT_CONFIG_BACKEND_DEFAULTS`：与后端 `AIChatConfigResponse`
 *   （backend/app/schemas/ai_chat.py）的 Field 默认值一一对应。改后端默认时
 *   只需同步这一处。
 * - `degradedAIChatConfig(message)`：拼装完整兜底 payload（含 prompt preset /
 *   scenario 列表），供 route 的两个降级分支复用。
 */

import { getPromptPresetSummaries, getScenarioPresetSummaries } from '@/lib/server/ai-chat'

/**
 * 与后端 pydantic `AIChatConfigResponse` 默认值对齐的数值字段。
 *
 * 对应关系（backend/app/schemas/ai_chat.py）：
 *   default_reasoning_effort : str = Field(default="medium")
 *   timeout_seconds          : int = Field(default=90, ge=10, le=300)
 *   max_conversation_turns   : int = Field(default=10, ge=1, le=50)
 *   web_search_max_results   : int = Field(default=5, ge=1, le=50)
 */
export const AI_CHAT_CONFIG_BACKEND_DEFAULTS = {
  defaultReasoningEffort: 'medium',
  timeoutSeconds: 90,
  maxConversationTurns: 10,
  webSearchMaxResults: 5,
} as const

export type DegradedAIChatConfig = ReturnType<typeof degradedAIChatConfig>

/**
 * 构建降级配置 payload。`message` 为面向用户的失败原因。
 *
 * provider/webSearch 关闭、模型列表清空是前端侧的"安全降级"语义（非后端默认）；
 * 数值字段取自 {@link AI_CHAT_CONFIG_BACKEND_DEFAULTS}（对齐后端 pydantic）。
 */
export function degradedAIChatConfig(message: string) {
  return {
    message,
    providerConfigured: false,
    webSearchConfigured: false,
    models: [] as string[],
    defaultModel: '',
    premiumModels: [] as string[],
    basicModels: [] as string[],
    reasoningModels: [] as string[],
    ...AI_CHAT_CONFIG_BACKEND_DEFAULTS,
    ...getPromptPresetSummaries(),
    ...getScenarioPresetSummaries(),
  }
}
