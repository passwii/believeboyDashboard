/**
 * AI Chat — client-side API layer.
 *
 * All functions hit the Next.js Route Handlers under `/api/ai-chat/...`,
 * which already inject the backend API key + session context server-side.
 * The client never carries the API key.
 *
 * Streamed responses are NOT handled here — see `./ai-chat-stream.ts` for the
 * ndjson consumer used by `useChatStream`.
 */

import { normalizeErrorMessage, parseResponseError } from '@/lib/error-utils'

// ── Types (mirror backend schemas/ai_chat.py) ─────────────────────────────

export type SearchSource = {
  title?: string
  url?: string
  snippet?: string
  domain?: string
  score?: number | null
  favicon?: string | null
}

/**
 * [BEL-81.B] 联网搜索时间范围标签。后端 `detect_time_range_from_query`
 * 与 `tool.time_range` 透传，存到 `ai_messages.search_time_range`。
 *
 * 'all' 由前端用 `!== 'all'` 判定为"不显示 chip"，与后端 None 等价。
 * 其他取值对应 UI 上的「今日 / 近 7 天 / 近 30 天 / 近 1 年」 chip。
 */
export type SearchTimeRange = 'day' | 'week' | 'month' | 'year' | 'all'

export type ChatMessageRole = 'user' | 'assistant'

export type ServerChatMessage = {
  id: number
  conversation_id: number
  role: ChatMessageRole
  content: string
  search_sources: SearchSource[]
  /** [BEL-81.B] 历史消息回放时携带的时间范围 chip 标签。 */
  search_time_range?: SearchTimeRange | null
  is_complete: boolean
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  duration_ms: number | null
  created_at: string
}

export type ServerConversation = {
  id: number
  title: string
  created_at: string
  updated_at: string
  total_prompt_tokens: number
  total_completion_tokens: number
  total_tokens: number
}

export type PromptPresetOption = {
  id: string
  label: string
  description: string
}

export type AIChatConfig = {
  providerConfigured: boolean
  webSearchConfigured: boolean
  models: string[]
  defaultModel: string
  premiumModels: string[]
  basicModels: string[]
  reasoningModels: string[]
  defaultReasoningEffort: string
  timeoutSeconds: number
  maxConversationTurns: number
  webSearchMaxResults: number
  overviewOptions: PromptPresetOption[]
  detailOptions: PromptPresetOption[]
}

export type RegenerateTitleResponse = {
  conversation: ServerConversation
  regenerated: boolean
}

// ── Internal helpers ──────────────────────────────────────────────────────

async function handleJson<T>(res: Response, fallback: string): Promise<T> {
  if (res.ok) {
    return (await res.json()) as T
  }
  throw new Error(await parseResponseError(res, fallback))
}

// ── Config ────────────────────────────────────────────────────────────────

export async function fetchAIChatConfig(signal?: AbortSignal): Promise<AIChatConfig> {
  const res = await fetch('/api/ai-chat/config', { method: 'GET', signal, cache: 'no-store' })
  return handleJson<AIChatConfig>(res, '加载 AI 配置失败')
}

// ── Conversations ─────────────────────────────────────────────────────────

export async function listConversations(signal?: AbortSignal): Promise<ServerConversation[]> {
  const res = await fetch('/api/ai-chat/conversations', { method: 'GET', signal, cache: 'no-store' })
  return handleJson<ServerConversation[]>(res, '加载会话失败')
}

export async function createConversation(title?: string): Promise<ServerConversation> {
  const res = await fetch('/api/ai-chat/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
    cache: 'no-store',
  })
  return handleJson<ServerConversation>(res, '创建会话失败')
}

export async function renameConversation(id: number, title: string): Promise<ServerConversation> {
  const res = await fetch(`/api/ai-chat/conversations/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
    cache: 'no-store',
  })
  return handleJson<ServerConversation>(res, '重命名会话失败')
}

export async function deleteConversation(id: number): Promise<void> {
  const res = await fetch(`/api/ai-chat/conversations/${id}`, {
    method: 'DELETE',
    cache: 'no-store',
  })
  if (!res.ok && res.status !== 204) {
    throw new Error(await parseResponseError(res, '删除会话失败'))
  }
}

export async function regenerateConversationTitle(id: number): Promise<RegenerateTitleResponse> {
  const res = await fetch(`/api/ai-chat/conversations/${id}`, {
    method: 'POST',
    cache: 'no-store',
  })
  return handleJson<RegenerateTitleResponse>(res, '重生成标题失败')
}

// ── Messages (history) ────────────────────────────────────────────────────

export async function getMessages(conversationId: number, signal?: AbortSignal): Promise<ServerChatMessage[]> {
  const res = await fetch(`/api/ai-chat/conversations/${conversationId}/messages`, {
    method: 'GET',
    signal,
    cache: 'no-store',
  })
  return handleJson<ServerChatMessage[]>(res, '加载消息失败')
}

// ── Errors ────────────────────────────────────────────────────────────────

/**
 * Public error helper — used by UI to normalize streamed error messages
 * (e.g. backend may return a JSON-encoded detail, a plain string, or nothing).
 */
export function normalizeStreamError(message: string | null | undefined, fallback: string): string {
  return normalizeErrorMessage(message, fallback)
}
