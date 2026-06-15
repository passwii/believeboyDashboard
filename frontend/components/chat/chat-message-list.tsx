'use client'

import { useState } from 'react'
import { Brain, Bot, Globe, RefreshCw, User } from 'lucide-react'
import { AIChatMessageContent } from '@/components/ai-chat-message-content'
import { AIChatSearchSources } from '@/components/ai-chat-search-sources'
import { TypingIndicator } from './typing-indicator'
import { MessageActions } from './message-actions'
import type { ChatMessage } from './types'
import type { SearchSource } from '@/lib/api/ai-chat'

interface ChatMessageListProps {
  messages: ChatMessage[]
  onRegenerate?: (messageId: string) => void
  onEdit?: (messageId: string) => void
  onDelete?: (messageId: string) => void
  /** Top-level stream error (network failure, backend down, etc.) — shown
   *  next to the most recent assistant message with a retry CTA. */
  streamError?: string | null
  onRetry?: () => void
  /** In-flight web-search status for the latest assistant turn. When the
   *  message has no content yet and the backend reports a tool call is
   *  searching, we render a dedicated "正在搜索…" badge instead of the
   *  generic typing dots so the user knows the wait is meaningful. */
  pendingSearchState?: { searching: boolean; sources: SearchSource[] } | null
  /** True when any message in this conversation used web search
   *  (searchSources.length > 0). Drives the sticky "已在线" status bar. */
  usedWebSearch?: boolean
}

function formatDuration(ms?: number | null): string {
  if (!ms || ms <= 0) return ''
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function TokenFooter({ message }: { message: ChatMessage }) {
  if (!message.tokenUsage && !message.durationMs) return null
  const parts: string[] = []
  if (message.tokenUsage) {
    parts.push(
      `prompt ${message.tokenUsage.prompt} · completion ${message.tokenUsage.completion} · total ${message.tokenUsage.total}`,
    )
  }
  if (message.durationMs) {
    parts.push(formatDuration(message.durationMs))
  }
  return (
    <div className="mt-1.5 flex items-center gap-1 px-1 text-[10px] text-[#5a5a5f]">
      <span>{parts.join(' · ')}</span>
    </div>
  )
}

function ThinkingBlock({ content }: { content: string }) {
  const [open, setOpen] = useState(false)
  if (!content) return null
  return (
    <details
      className="mb-2 rounded-lg border border-white/[0.06] bg-white/[0.02] text-xs"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="flex cursor-pointer items-center gap-1.5 px-3 py-1.5 text-[#8a8a8f] hover:text-white select-none">
        <Brain className="size-3" />
        <span>思考过程</span>
      </summary>
      <div className="px-3 pb-2.5 pt-1 text-[#a0a0a5] whitespace-pre-wrap break-words leading-5">
        {content}
      </div>
    </details>
  )
}

export function ChatMessageList({
  messages,
  onRegenerate,
  onEdit,
  onDelete,
  streamError,
  onRetry,
  pendingSearchState,
  usedWebSearch = false,
}: ChatMessageListProps) {
  // Find the last assistant message so we can attach the top-level stream
  // error to it (with a retry button).
  const lastAssistantIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') return i
    }
    return -1
  })()

  return (
    <div className="mx-auto max-w-3xl space-y-5 sm:space-y-7">
      {/* Sticky "已在线" status bar — surfaces whenever any message in
          this conversation was produced via web search, so the user
          can see at a glance why a given answer is grounded in fresh
          data. Fades in on first appearance. */}
      {usedWebSearch && (
        <div
          role="status"
          aria-label="本对话已开启联网"
          className="sticky top-0 z-10 -mx-1 flex items-center gap-1.5 rounded-full border border-blue-500/20 bg-blue-500/[0.06] px-3 py-1 text-[11px] font-medium text-blue-300 backdrop-blur-sm animate-fade-slide-up"
        >
          <Globe aria-hidden="true" className="h-3 w-3 shrink-0" />
          <span>本对话已开启联网</span>
        </div>
      )}
      {messages.map((msg, index) => (
        <div
          key={msg.id}
          className={`group relative animate-enter ${
            msg.role === 'user' ? 'justify-end' : 'justify-start'
          }`}
          style={{ animationDelay: `${index * 60}ms` }}
        >
          <div
            className={`flex gap-3 sm:gap-4 ${
              msg.role === 'user' ? 'flex-row-reverse' : ''
            }`}
          >
            {/* Avatar */}
            <div className="flex h-8 w-8 sm:h-9 sm:w-9 shrink-0 items-center justify-center rounded-full bg-white/[0.08] border border-white/[0.06]">
              {msg.role === 'assistant' ? (
                <Bot className="h-4 w-4 sm:h-[18px] sm:w-[18px] text-blue-400/70" />
              ) : (
                <User className="h-4 w-4 sm:h-[18px] sm:w-[18px] text-white/50" />
              )}
            </div>

            {/* Message bubble */}
            <div
              className={`flex flex-col gap-1.5 max-w-[88%] sm:max-w-[85%] ${
                msg.role === 'user' ? 'items-end' : 'items-start'
              }`}
            >
              <div
                className={`relative px-4 sm:px-5 py-3 sm:py-3.5 ${
                  msg.role === 'user'
                    ? 'bg-white/[0.08] rounded-2xl rounded-tr-md text-white'
                    : 'text-[#e6e6e8]'
                }`}
              >
                {msg.role === 'assistant' && msg.thinking ? (
                  <ThinkingBlock content={msg.thinking} />
                ) : null}

                {msg.role === 'user' ? (
                  <p className="whitespace-pre-wrap break-words text-[15px] sm:text-base leading-7 sm:leading-[1.75] text-white">
                    {msg.content}
                  </p>
                ) : msg.content ? (
                  <AIChatMessageContent
                    content={msg.content}
                    className="text-[15px] sm:text-[16px] leading-7 sm:leading-[1.75] text-[#e6e6e8] [&_p]:text-[15px] sm:[&_p]:text-[16px] [&_p]:leading-7 sm:[&_p]:leading-[1.75] [&_p]:text-[#e6e6e8] [&_strong]:text-white [&_em]:text-[#e6e6e8] [&_h2]:mt-5 [&_h2]:text-[17px] sm:[&_h2]:text-[19px] [&_h2]:font-semibold [&_h2]:text-white [&_h3]:mt-4 [&_h3]:text-[15px] sm:[&_h3]:text-[16px] [&_h3]:font-semibold [&_h3]:text-white [&_li]:text-[#d8d8db] [&_li]:leading-7 sm:[&_li]:leading-[1.75]"
                  />
                ) : msg.streaming && pendingSearchState?.searching ? (
                  // Web-search tool is in flight: surface a dedicated badge
                  // so the wait reads as "fetching the web" rather than a
                  // generic typing pulse. Once the first token arrives the
                  // `msg.content` branch above takes over and this naturally
                  // disappears — no manual teardown needed.
                  <div className="flex items-center gap-2 text-xs text-blue-300/80">
                    <span className="size-1.5 rounded-full bg-blue-400 animate-pulse shadow-[0_0_6px_rgba(96,165,250,0.6)]" />
                    <Globe className="size-3" />
                    <span>正在搜索…</span>
                  </div>
                ) : (
                  <TypingIndicator />
                )}

                {/* Error state */}
                {msg.error && (
                  <div className="mt-2 rounded-lg border border-red-500/20 bg-red-500/[0.06] px-3 py-2 text-xs text-red-400">
                    生成失败，请重试
                  </div>
                )}
              </div>

              {/* Search sources — render whenever the message has sources OR
                  is still waiting for them. The `searching` flag drives the
                  skeleton cards (B3), `searchTimeRange` powers the time-range
                  chip (B2). */}
              {msg.role === 'assistant' &&
                (msg.searchSearching ||
                  (msg.searchSources && msg.searchSources.length > 0)) && (
                  <AIChatSearchSources
                    sources={msg.searchSources ?? []}
                    timeRange={msg.searchTimeRange ?? null}
                    query={msg.searchQuery ?? null}
                    searching={!!msg.searchSearching && !(msg.searchSources && msg.searchSources.length > 0)}
                  />
                )}

              {/* Token / duration footer — only on completed assistant messages. */}
              {msg.role === 'assistant' && !msg.streaming && (
                <TokenFooter message={msg} />
              )}

              {/* Streaming indicator — blue-300 (matches the web-search
                  toggle) while we're in the search phase, blue-400/50
                  (quieter) during the pure generation phase. */}
              {msg.streaming && msg.content && (
                <span
                  className={`flex items-center gap-1 px-1 text-xs ${
                    msg.searchSources && msg.searchSources.length > 0
                      ? 'text-blue-300'
                      : 'text-blue-400/50'
                  }`}
                >
                  <span
                    className={`h-1 w-1 rounded-full animate-pulse ${
                      msg.searchSources && msg.searchSources.length > 0
                        ? 'bg-blue-300'
                        : 'bg-blue-400/50'
                    }`}
                  />
                  <span className="hidden sm:inline">
                    {msg.searchSources && msg.searchSources.length > 0
                      ? '搜索中...'
                      : '生成中...'}
                  </span>
                </span>
              )}

              {/* Top-level stream error attached to the last assistant message. */}
              {streamError && index === lastAssistantIndex && !msg.streaming && onRetry && (
                <div className="mt-1 flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/[0.06] px-3 py-2 text-xs text-red-400">
                  <span className="flex-1">{streamError}</span>
                  <button
                    type="button"
                    onClick={onRetry}
                    className="flex items-center gap-1 rounded-md bg-white/[0.06] px-2 py-0.5 text-red-200 hover:bg-white/[0.12] hover:text-white transition-colors"
                  >
                    <RefreshCw className="size-3" />
                    <span>重试</span>
                  </button>
                </div>
              )}

              {/* Action toolbar — hidden while streaming to avoid stale state. */}
              {!msg.streaming && msg.content && (
                <div className="px-1">
                  <MessageActions
                    role={msg.role}
                    content={msg.content}
                    onRegenerate={
                      msg.role === 'assistant' && onRegenerate
                        ? () => onRegenerate(msg.id)
                        : undefined
                    }
                    onEdit={
                      msg.role === 'user' && onEdit
                        ? () => onEdit(msg.id)
                        : undefined
                    }
                    onDelete={onDelete ? () => onDelete(msg.id) : undefined}
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
