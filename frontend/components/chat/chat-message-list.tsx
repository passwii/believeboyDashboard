'use client'

import { useState, useRef, useEffect } from 'react'
import { Brain, Bot, Check, Globe, Hash, RefreshCw, Sparkles, User, X } from 'lucide-react'
import gsap from 'gsap'
import { AIChatMessageContent } from '@/components/ai-chat-message-content'
import { AIChatSearchSources } from '@/components/ai-chat-search-sources'
import { TypingIndicator } from './typing-indicator'
import { MessageActions } from './message-actions'
import { TokenFooter } from './token-footer'
import type { ChatMessage } from './types'
import type { SearchSource } from '@/lib/api/ai-chat'
import type { StreamUsage } from '@/lib/api/ai-chat-stream-v2'
import { formatTokenCount } from '@/lib/format/token-count'

interface ChatMessageListProps {
  messages: ChatMessage[]
  onRegenerate?: (messageId: string) => void
  onEdit?: (messageId: string) => void
  onDelete?: (messageId: string) => void
  editingMessageId?: string | null
  onEditSave?: (messageId: string, newContent: string) => void
  onEditCancel?: () => void
  streamError?: string | null
  onRetry?: () => void
  pendingSearchState?: { searching: boolean; sources: SearchSource[] } | null
  pendingUsage?: StreamUsage | null
  usedWebSearch?: boolean
}

function ThinkingBlock({ content }: { content: string }) {
  const [open, setOpen] = useState(false)
  if (!content) return null
  return (
    <details
      className="mb-2 rounded-lg border text-xs bg-slate-50 border-slate-200 dark:bg-white/[0.02] dark:border-white/[0.06]"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="flex cursor-pointer items-center gap-1.5 px-3 py-1.5 select-none text-slate-500 hover:text-slate-700 dark:text-[#8a8a8f] dark:hover:text-white">
        <Brain className="size-3" />
        <span>思考过程</span>
      </summary>
      <div className="px-3 pb-2.5 pt-1 whitespace-pre-wrap break-words leading-5 text-slate-600 dark:text-[#a0a0a5]">
        {content}
      </div>
    </details>
  )
}

function UserMessageEdit({
  initialContent,
  onSave,
  onCancel,
}: {
  initialContent: string
  onSave: (content: string) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState(initialContent)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = textareaRef.current
    if (el) {
      el.focus()
      el.selectionStart = el.selectionEnd = el.value.length
    }
  }, [])

  const handleSave = () => {
    const trimmed = draft.trim()
    if (trimmed && trimmed !== initialContent) onSave(trimmed)
    else onCancel()
  }

  return (
    <div className="flex flex-col gap-2">
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSave()
          if (e.key === 'Escape') onCancel()
        }}
        rows={Math.min(6, Math.max(2, draft.split('\n').length))}
        className="w-full resize-none rounded-xl border px-4 py-3 text-[15px] leading-7 outline-none transition-colors bg-white border-slate-200 text-slate-900 placeholder:text-slate-400 focus:border-blue-400 dark:bg-white/[0.04] dark:border-white/[0.12] dark:text-white dark:placeholder:text-[#4a4a4f] dark:focus:border-blue-500/50 dark:focus:bg-white/[0.06]"
      />
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={handleSave}
          className="flex items-center gap-1 rounded-lg bg-blue-600/80 px-2.5 py-1 text-xs text-white hover:bg-blue-600 transition-colors"
        >
          <Check className="size-3" />
          保存
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs transition-colors bg-slate-100 text-slate-500 hover:bg-slate-200 hover:text-slate-700 dark:bg-white/[0.06] dark:text-[#8a8a8f] dark:hover:bg-white/[0.1] dark:hover:text-white"
        >
          <X className="size-3" />
          取消
        </button>
        <span className="ml-1 text-[10px] text-slate-400 dark:text-[#3a3a3f]">⌘Enter 保存 · Esc 取消</span>
      </div>
    </div>
  )
}

export function ChatMessageList({
  messages,
  onRegenerate,
  onEdit,
  onDelete,
  editingMessageId,
  onEditSave,
  onEditCancel,
  streamError,
  onRetry,
  pendingSearchState,
  pendingUsage,
  usedWebSearch = false,
}: ChatMessageListProps) {
  const messageRefs = useRef(new Map<string, HTMLDivElement>())
  const prevLengthRef = useRef(0)

  useEffect(() => {
    if (messages.length > prevLengthRef.current) {
      const newIndices: number[] = []
      for (let i = prevLengthRef.current; i < messages.length; i++) {
        newIndices.push(i)
      }
      newIndices.forEach((idx) => {
        const msg = messages[idx]
        const el = messageRefs.current.get(msg.id)
        if (el) {
          gsap.fromTo(
            el,
            { opacity: 0, y: 16, scale: 0.98 },
            {
              opacity: 1,
              y: 0,
              scale: 1,
              duration: 0.35,
              delay: idx * 0.04,
              ease: 'power3.out',
            }
          )
        }
      })
    }
    prevLengthRef.current = messages.length
  }, [messages.length])

  const lastAssistantIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') return i
    }
    return -1
  })()

  return (
    <div className="mx-auto max-w-3xl space-y-5 sm:space-y-7">
      {usedWebSearch && (
        <div
          role="status"
          aria-label="本对话已开启联网"
          className="sticky top-0 z-10 -mx-1 flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-medium backdrop-blur-sm animate-fade-slide-up bg-blue-50 border-blue-200 text-blue-600 dark:bg-blue-500/[0.06] dark:border-blue-500/20 dark:text-blue-300"
        >
          <Globe aria-hidden="true" className="h-3 w-3 shrink-0" />
          <span>本对话已开启联网</span>
        </div>
      )}

      {messages.length === 0 && !pendingSearchState?.searching && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Sparkles className="size-8 mb-3 text-slate-300 dark:text-[#3a3a3f]" />
          <p className="text-sm text-slate-500 dark:text-[#5a5a5f]">开始对话，AI 将帮助你分析数据</p>
          <p className="text-xs mt-1 text-slate-400 dark:text-[#4a4a4f]">在下方输入问题或选择推荐问题开始</p>
        </div>
      )}

      {messages.map((msg, index) => (
        <div
          key={msg.id}
          ref={(el) => {
            if (el) messageRefs.current.set(msg.id, el)
            else messageRefs.current.delete(msg.id)
          }}
          className={`group relative ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
        >
          <div className={`flex gap-3 sm:gap-4 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
            <div className="flex h-8 w-8 sm:h-9 sm:w-9 shrink-0 items-center justify-center rounded-full border bg-white border-slate-200 dark:bg-white/[0.08] dark:border-white/[0.06]">
              {msg.role === 'assistant' ? (
                <Bot className="h-4 w-4 sm:h-[18px] sm:w-[18px] text-blue-500 dark:text-blue-400/70" />
              ) : (
                <User className="h-4 w-4 sm:h-[18px] sm:w-[18px] text-slate-500 dark:text-white/50" />
              )}
            </div>

            <div
              className={`flex flex-col gap-1.5 max-w-[88%] sm:max-w-[85%] ${
                msg.role === 'user' ? 'items-end' : 'items-start'
              }`}
            >
              <div
                className={`relative px-4 sm:px-5 py-3 sm:py-3.5 ${
                  msg.role === 'user'
                    ? 'rounded-2xl rounded-tr-md bg-white border border-slate-200 shadow-sm text-slate-900 dark:bg-white/[0.08] dark:border-transparent dark:shadow-none dark:text-white'
                    : 'text-slate-700 dark:text-[#e6e6e8]'
                }`}
              >
                {msg.role === 'assistant' && msg.thinking ? (
                  <ThinkingBlock content={msg.thinking} />
                ) : null}

                {msg.role === 'user' ? (
                  editingMessageId === msg.id && onEditSave && onEditCancel ? (
                    <UserMessageEdit
                      initialContent={msg.content}
                      onSave={(content) => onEditSave(msg.id, content)}
                      onCancel={onEditCancel}
                    />
                  ) : (
                    <p className="whitespace-pre-wrap break-words text-[15px] sm:text-base leading-7 sm:leading-[1.75] text-slate-900 dark:text-white">
                      {msg.content}
                    </p>
                  )
                ) : msg.content ? (
                  <AIChatMessageContent
                    content={msg.content}
                    className="text-[15px] sm:text-[16px] leading-7 sm:leading-[1.75] text-slate-700 dark:text-[#e6e6e8] [&_p]:text-[15px] sm:[&_p]:text-[16px] [&_p]:leading-7 sm:[&_p]:leading-[1.75] [&_p]:text-slate-700 dark:[&_p]:text-[#e6e6e8] [&_strong]:text-slate-900 dark:[&_strong]:text-white [&_em]:text-slate-700 dark:[&_em]:text-[#e6e6e8] [&_h2]:mt-5 [&_h2]:text-[17px] sm:[&_h2]:text-[19px] [&_h2]:font-semibold [&_h2]:text-slate-900 dark:[&_h2]:text-white [&_h3]:mt-4 [&_h3]:text-[15px] sm:[&_h3]:text-[16px] [&_h3]:font-semibold [&_h3]:text-slate-900 dark:[&_h3]:text-white [&_li]:text-slate-600 dark:[&_li]:text-[#d8d8db] [&_li]:leading-7 sm:[&_li]:leading-[1.75]"
                  />
                ) : msg.streaming && pendingSearchState?.searching ? (
                  <div className="flex items-center gap-2 text-xs text-blue-600 dark:text-blue-300/80">
                    <span className="size-1.5 rounded-full bg-blue-500 animate-pulse shadow-[0_0_6px_rgba(96,165,250,0.6)]" />
                    <Globe className="size-3" />
                    <span>正在搜索…</span>
                  </div>
                ) : (
                  <TypingIndicator />
                )}

                {msg.error && (
                  <div className="mt-2 rounded-lg border px-3 py-2 text-xs bg-red-50 border-red-200 text-red-600 dark:bg-red-500/[0.06] dark:border-red-500/20 dark:text-red-400">
                    生成失败，请重试
                  </div>
                )}
              </div>

              {msg.role === 'assistant' &&
                (msg.searchSearching || (msg.searchSources && msg.searchSources.length > 0)) && (
                  <AIChatSearchSources
                    sources={msg.searchSources ?? []}
                    timeRange={msg.searchTimeRange ?? null}
                    query={msg.searchQuery ?? null}
                    searching={
                      !!msg.searchSearching && !(msg.searchSources && msg.searchSources.length > 0)
                    }
                  />
                )}

              {msg.role === 'assistant' && !msg.streaming && (
                <TokenFooter tokenUsage={msg.tokenUsage} durationMs={msg.durationMs} />
              )}

              {msg.streaming && msg.content && (
                <span
                  className={`flex items-center gap-1 px-1 text-xs ${
                    msg.searchSources && msg.searchSources.length > 0
                      ? 'text-blue-600 dark:text-blue-300'
                      : 'text-blue-500/60 dark:text-blue-400/50'
                  }`}
                >
                  <span
                    className={`h-1 w-1 rounded-full animate-pulse ${
                      msg.searchSources && msg.searchSources.length > 0
                        ? 'bg-blue-500 dark:bg-blue-300'
                        : 'bg-blue-500/50 dark:bg-blue-400/50'
                    }`}
                  />
                  <span className="hidden sm:inline">
                    {msg.searchSources && msg.searchSources.length > 0 ? '搜索中...' : '生成中...'}
                  </span>
                  {pendingUsage && (pendingUsage.total_tokens > 0 || pendingUsage.prompt_tokens > 0) && (
                    <span
                      className="ml-1 hidden items-center gap-0.5 rounded-md border px-1 py-0.5 text-[10px] font-medium sm:inline-flex bg-white border-slate-200 text-slate-500 dark:bg-white/[0.03] dark:border-white/[0.06] dark:text-[#8a8a8f]"
                      aria-label={`当前累计 ${formatTokenCount(pendingUsage.total_tokens)} tokens`}
                    >
                      <Hash className="size-2.5 text-slate-400 dark:text-[#5a5a5f]" aria-hidden />
                      <span>{formatTokenCount(pendingUsage.total_tokens)}</span>
                    </span>
                  )}
                </span>
              )}

              {streamError && index === lastAssistantIndex && !msg.streaming && onRetry && (
                <div className="mt-1 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs bg-red-50 border-red-200 text-red-600 dark:bg-red-500/[0.06] dark:border-red-500/20 dark:text-red-400">
                  <span className="flex-1">{streamError}</span>
                  <button
                    type="button"
                    onClick={onRetry}
                    className="flex items-center gap-1 rounded-md px-2 py-0.5 transition-colors bg-white border border-slate-200 text-red-600 hover:bg-slate-50 dark:bg-white/[0.06] dark:border-transparent dark:text-red-200 dark:hover:bg-white/[0.12] dark:hover:text-white"
                  >
                    <RefreshCw className="size-3" />
                    <span>重试</span>
                  </button>
                </div>
              )}

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
                    onEdit={msg.role === 'user' && onEdit ? () => onEdit(msg.id) : undefined}
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
