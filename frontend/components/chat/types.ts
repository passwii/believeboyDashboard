import type { ReactNode } from 'react'

import type { SearchSource, SearchTimeRange } from '@/lib/api/ai-chat'

export interface Model {
  id: string
  name: string
  shortName?: string
  description: string
  icon: ReactNode
  badge?: string
}

export interface ModelGroup {
  id: string
  label: string
  models: Model[]
  /** Only used for the collapsible "others" group: default collapsed state. */
  collapsedByDefault?: boolean
}

export interface TextSegment {
  text: string
  highlight?: boolean
  speed: number
}

export type Phase = 'landing' | 'transitioning' | 'chat'

export type ChatMessageRole = 'user' | 'assistant'

export type TokenUsage = {
  prompt: number
  completion: number
  total: number
}

export interface ChatMessage {
  /** Stable client-side React key (always set, even for optimistic placeholders). */
  id: string
  /** Backend primary key — present once the message has been persisted. */
  serverId?: number
  role: ChatMessageRole
  content: string
  streaming?: boolean
  error?: boolean
  /** Web-search source cards attached to this assistant message. */
  searchSources?: SearchSource[]
  /** [BEL-81.B] 联网搜索时间范围标签，用于历史回放时显示 chip。 */
  searchTimeRange?: SearchTimeRange | null
  /** 联网搜索真实搜索词（可选）。 */
  searchQuery?: string | null
  /** [BEL-81.B] 父组件传：tool_searching 阶段是否仍在等待结果。 */
  searchSearching?: boolean
  /** Accumulated "thinking" deltas (collapsible in the UI). */
  thinking?: string
  tokenUsage?: TokenUsage
  durationMs?: number
  createdAt?: string
}

export interface Conversation {
  /** Stable client-side id (e.g. `local-<n>` for empty placeholders, or `<serverId>` once persisted). */
  id: string
  serverId?: number
  title: string
  createdAt: number
  updatedAt?: number
  messageCount: number
  /** 会话累计 token 总用量（来自后端 `ai_conversations.total_tokens`）。为 0 时不展示。 */
  totalTokens?: number
  /** 会话累计 prompt / completion token（来自后端）。用于侧边栏 hover 展开细节。 */
  totalPromptTokens?: number
  totalCompletionTokens?: number
}

export interface AIChatWindowProps {
  title?: string
  titleHighlight?: string
  subtitle?: string
  announcementText?: string
  announcementHref?: string
  placeholder?: string
  showInput?: boolean
  onSend?: (message: string) => void
}

export type StreamCallbacks = {
  onChunk: (delta: string) => void
  onDone: () => void
  onError: (error: string) => void
}
