/**
 * AI Chat stream — 共享流式类型。
 *
 * V2 切换后本文件仅保留 V2 SSE consumer（`./ai-chat-stream-v2`）与 hook
 * （`@/components/chat/hooks/use-chat-stream-v2`）共用的类型定义。
 * 旧 ndjson consumer（consumeStream / dispatchEvent）随 V1 流式路径删除。
 */

import type { ServerChatMessage, SearchSource, SearchTimeRange } from './ai-chat'

export type StreamUsage = {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

export type StreamToolState = {
  toolCallsCount: number
  searching: boolean
  done: boolean
}

export type StreamDonePayload = {
  userMessage: ServerChatMessage
  assistantMessage: ServerChatMessage
  conversationTitle: string | null
  tokenUsage: StreamUsage | null
  /**
   * Conversation-level cumulative token usage (prompt / completion / total).
   * The backend emits this in the `done` event; we surface it for sidebar
   * totals and other future UI. Optional so the consumer can ignore it
   * without an extra type guard.
   */
  conversationTokenUsage?: StreamUsage | null
  durationMs: number | null
  titleRegenerated: boolean
}

export type StreamCallbacks = {
  onStart?: () => void
  onChunk?: (delta: string) => void
  onThinking?: (delta: string) => void
  onSources?: (
    sources: SearchSource[],
    meta?: { timeRange?: SearchTimeRange; query?: string }
  ) => void
  onUsage?: (usage: StreamUsage) => void
  onToolState?: (state: StreamToolState) => void
  onDone?: (payload: StreamDonePayload) => void
  onError?: (message: string) => void
}
