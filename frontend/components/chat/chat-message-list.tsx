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
import styles from './warm-chat.module.css'

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
      className={`${styles.thinkingBlock} mb-2 border text-xs`}
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="flex cursor-pointer items-center gap-1.5 px-3 py-1.5 select-none">
        <Brain className="size-3" />
        <span>思考过程</span>
      </summary>
      <div className="px-3 pb-2.5 pt-1 whitespace-pre-wrap break-words leading-5">
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
        className={`${styles.inputCard} w-full resize-none px-4 py-3 text-[15px] leading-7 outline-none`}
      />
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={handleSave}
          className={`${styles.sendButton} flex items-center gap-1 px-2.5 py-1 text-xs`}
        >
          <Check className="size-3" />
          保存
        </button>
        <button
          type="button"
          onClick={onCancel}
          className={`${styles.chip} flex items-center gap-1 px-2.5 py-1 text-xs`}
        >
          <X className="size-3" />
          取消
        </button>
        <span className={`${styles.typingText} ml-1 text-[10px]`}>⌘Enter 保存 · Esc 取消</span>
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
  }, [messages])

  const lastAssistantIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') return i
    }
    return -1
  })()

  return (
    <div className={`${styles.messageList} mx-auto max-w-3xl space-y-5 sm:space-y-7`}>
      {usedWebSearch && (
        <div
          role="status"
          aria-label="本对话已开启联网"
          className={`${styles.searchStatus} sticky top-0 z-10 -mx-1 flex items-center gap-1.5 px-3 py-1 text-[11px] font-medium animate-fade-slide-up`}
        >
          <Globe aria-hidden="true" className="h-3 w-3 shrink-0" />
          <span>本对话已开启联网</span>
        </div>
      )}

      {messages.length === 0 && !pendingSearchState?.searching && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Sparkles className={`${styles.chipAccent} size-8 mb-3`} />
          <p className={`${styles.typingText} text-sm`}>开始对话，AI 将帮助你分析数据</p>
          <p className={`${styles.typingText} text-xs mt-1`}>在下方输入问题或选择推荐问题开始</p>
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
            <div className={`${styles.messageAvatar} flex h-8 w-8 sm:h-9 sm:w-9 shrink-0 items-center justify-center rounded-full`}>
              {msg.role === 'assistant' ? (
                <Bot className={`${styles.chipAccent} h-4 w-4 sm:h-[18px] sm:w-[18px]`} />
              ) : (
                <User className="h-4 w-4 sm:h-[18px] sm:w-[18px]" />
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
                    ? styles.userBubble
                    : styles.assistantBody
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
                    <p className="whitespace-pre-wrap break-words text-[15px] sm:text-base leading-7 sm:leading-[1.75]">
                      {msg.content}
                    </p>
                  )
                ) : msg.content ? (
                  <AIChatMessageContent
                    content={msg.content}
                    className={`${styles.assistantBody} text-[15px] sm:text-[16px] leading-7 sm:leading-[1.75]`}
                  />
                ) : msg.streaming && pendingSearchState?.searching ? (
                  <div className={`${styles.chipAccent} flex items-center gap-2 text-xs`}>
                    <span className={`${styles.typingDots} size-1.5 rounded-full animate-pulse`} />
                    <Globe className="size-3" />
                    <span>正在搜索…</span>
                  </div>
                ) : (
                  <TypingIndicator />
                )}

                {msg.error && (
                  <div className={`${styles.errorBox} mt-2 px-3 py-2 text-xs`}>
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
                      ? styles.chipAccent
                      : styles.typingText
                  }`}
                >
                  <span
                    className={`h-1 w-1 rounded-full animate-pulse ${
                      msg.searchSources && msg.searchSources.length > 0
                        ? styles.typingDots
                        : styles.typingDots
                    }`}
                  />
                  <span className="hidden sm:inline">
                    {msg.searchSources && msg.searchSources.length > 0 ? '搜索中...' : '生成中...'}
                  </span>
                  {pendingUsage && (pendingUsage.total_tokens > 0 || pendingUsage.prompt_tokens > 0) && (
                    <span
                      className={`${styles.tokenChip} ml-1 hidden items-center gap-0.5 px-1 py-0.5 text-[10px] font-medium sm:inline-flex`}
                      aria-label={`当前累计 ${formatTokenCount(pendingUsage.total_tokens)} tokens`}
                    >
                      <Hash className="size-2.5" aria-hidden />
                      <span>{formatTokenCount(pendingUsage.total_tokens)}</span>
                    </span>
                  )}
                </span>
              )}

              {streamError && index === lastAssistantIndex && !msg.streaming && onRetry && (
                <div className={`${styles.errorBox} mt-1 flex items-center gap-2 px-3 py-2 text-xs`}>
                  <span className="flex-1">{streamError}</span>
                  <button
                    type="button"
                    onClick={onRetry}
                    className={`${styles.actionButton} flex items-center gap-1 px-2 py-0.5`}
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
