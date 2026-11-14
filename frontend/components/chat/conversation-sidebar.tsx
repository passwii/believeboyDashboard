'use client'

import { useState, useRef, useEffect } from 'react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import {
  Plus,
  MessageSquare,
  Pencil,
  Trash2,
  Check,
  X,
  PanelLeftClose,
  Search,
  Sparkles,
  History,
  Hash,
} from 'lucide-react'
import { formatTokenCount } from '@/lib/format/token-count'
import type { Conversation } from './types'
import styles from './warm-chat.module.css'
import { useMobile } from '@/lib/hooks/use-mobile'

interface ConversationSidebarProps {
  conversations: Conversation[]
  activeId: string | null
  onSelect: (id: string) => void
  onCreate: () => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
  onClose: () => void
}

export function ConversationSidebar({
  conversations,
  activeId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onClose,
}: ConversationSidebarProps) {
  const isMobile = useMobile()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const editRef = useRef<HTMLInputElement>(null)
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (editingId && editRef.current) {
      editRef.current.focus()
      editRef.current.select()
    }
  }, [editingId])

  useGSAP(
    () => {
      if (hoveredId) {
        const el = itemRefs.current.get(hoveredId)
        if (el) {
          gsap.to(el, {
            x: 3,
            duration: 0.2,
            ease: 'none',
          })
        }
      } else {
        itemRefs.current.forEach((el) => {
          gsap.to(el, { x: 0, duration: 0.2 })
        })
      }
    },
    { scope: listRef }
  )

  const filtered = conversations.filter((c) =>
    c.title.toLowerCase().includes(searchQuery.toLowerCase())
  )

  const startRename = (conv: Conversation) => {
    setEditingId(conv.id)
    setEditValue(conv.title)
  }

  const commitRename = () => {
    if (editingId && editValue.trim()) {
      onRename(editingId, editValue.trim())
    }
    setEditingId(null)
  }

  const handleDeleteWithAnimation = (id: string) => {
    const el = itemRefs.current.get(id)
    if (el) {
      gsap.to(el, {
        opacity: 0,
        x: -20,
        height: 0,
        marginBottom: 0,
        paddingTop: 0,
        paddingBottom: 0,
        duration: 0.25,
        ease: 'power2.in',
        onComplete: () => onDelete(id),
      })
    } else {
      onDelete(id)
    }
  }

  return (
    <div
      className={`${styles.sidebar} absolute inset-y-0 left-0 z-40 flex w-[min(86vw,280px)] flex-col pointer-events-auto sm:w-[280px]`}
      data-testid="ai-chat-history-panel"
      style={{
        ['--sidebar-surface' as string]: 'var(--warm-ledger-color-sidebar)',
      }}
    >
      <div className="relative flex flex-col flex-1 min-h-0">
      {/* Header */}
      <div className={`${styles.sidebarHeader} flex items-center justify-between gap-3 px-4 pt-4 pb-3 border-b`}>
        <div className="min-w-0 flex-1 pr-3">
          <div className="flex items-center gap-2 min-w-0">
            <History className={styles.sidebarTitle} aria-hidden />
            <span className={`${styles.sidebarTitle} text-xs font-semibold uppercase tracking-[0.2em]`}>
              对话历史
            </span>
            <span className={`${styles.sidebarBadge} shrink-0 px-2 py-0.5 text-[10px] font-medium`}>
              自动保存
            </span>
          </div>
          <p className={`${styles.sidebarTitle} mt-1 truncate text-[10px] leading-4`}>全部会话会自动保存</p>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => {
              const btn = document.querySelector('.conv-new-btn')
              if (btn)
                gsap.fromTo(btn, { scale: 0.8 }, { scale: 1, duration: 0.3, ease: 'back.out(2)' })
              onCreate()
            }}
            className={`${styles.iconButton} conv-new-btn size-8 active:scale-95`}
            aria-label="新建对话"
          >
            <Plus className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              const el = document.querySelector('[data-sidebar]')
              if (el)
                gsap.to(el, {
                  opacity: 0,
                  x: -280,
                  duration: 0.25,
                  ease: 'power2.in',
                  onComplete: onClose,
                })
            }}
            className={`${styles.iconButton} size-8 active:scale-95`}
            aria-label="关闭侧边栏"
          >
            <PanelLeftClose className="size-4" />
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="px-3 pt-3 pb-2">
        <div className="relative">
          <Search className={`${styles.sidebarTitle} absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 pointer-events-none`} />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索对话..."
            className={`${styles.sidebarSearch} w-full pl-8 pr-3 py-2.5 text-[13px] outline-none`}
          />
        </div>
      </div>

      {/* Conversation list */}
      <div ref={listRef} className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5" data-sidebar>
        {filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center py-14 text-center px-4">
            {searchQuery ? (
              <>
                <Search className={`${styles.sidebarTitle} size-7 mb-3`} />
                <p className={`${styles.sidebarTitle} text-xs`}>没有匹配的对话</p>
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className={`${styles.sidebarTitle} mt-2 text-xs underline underline-offset-2`}
                >
                  清除搜索
                </button>
              </>
            ) : (
              <>
                <div className="relative mb-4">
                  <MessageSquare className={`${styles.sidebarTitle} size-8`} />
                  <Sparkles className={`${styles.chipAccent} size-3 absolute -top-1 -right-1`} />
                </div>
                <p className={`${styles.sidebarTitle} text-sm font-medium`}>还没有对话</p>
                <p className={`${styles.sidebarTitle} text-xs mt-1 mb-4`}>发送一条消息即可自动创建</p>
                <button
                  type="button"
                  onClick={onCreate}
                  className={`${styles.chip} flex items-center gap-1.5 px-3 py-2 text-xs font-medium active:scale-95`}
                >
                  <Plus className="size-3.5" />
                  开始新对话
                </button>
              </>
            )}
          </div>
        )}
        {filtered.map((conv) => (
          <div
            key={conv.id}
            ref={(el) => {
              if (el) itemRefs.current.set(conv.id, el)
              else itemRefs.current.delete(conv.id)
            }}
            onClick={() => {
              if (editingId !== conv.id) {
                const el = itemRefs.current.get(conv.id)
                if (el)
                  gsap.fromTo(el, { scale: 0.98 }, { scale: 1, duration: 0.15, ease: 'power2.out' })
                onSelect(conv.id)
              }
            }}
            onMouseEnter={() => setHoveredId(conv.id)}
            onMouseLeave={() => setHoveredId(null)}
            className={`group relative flex items-center gap-3 px-3 py-3 sm:py-2.5 rounded-xl cursor-pointer transition-all duration-[var(--duration-quick)] min-h-[44px] sm:min-h-[auto] ${
              activeId === conv.id
                ? styles.conversationRowActive
                : styles.conversationRow
            }`}
          >
            <MessageSquare className="size-4 shrink-0 opacity-60 mt-0.5 self-start" />

            {editingId === conv.id ? (
              <div className="flex-1 flex items-center gap-1.5 min-w-0">
                <input
                  ref={editRef}
                  type="text"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename()
                    if (e.key === 'Escape') setEditingId(null)
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className={`${styles.sidebarSearch} flex-1 min-w-0 px-2 py-1.5 text-[13px] outline-none`}
                />
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    commitRename()
                  }}
                  className={`${styles.actionButton} ${styles.chipAccent} shrink-0 p-1.5`}
                  aria-label="确认重命名"
                >
                  <Check className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    setEditingId(null)
                  }}
                  className={`${styles.actionButton} shrink-0 p-1.5`}
                  aria-label="取消重命名"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ) : (
              <>
                <div className="flex-1 min-w-0">
                  <span className="block text-[13px] font-medium truncate pr-1">{conv.title}</span>
                  {(conv.messageCount > 0 || (conv.totalTokens ?? 0) > 0) && (
                    <div className={`${styles.sidebarTitle} mt-0.5 flex items-center gap-2 text-[10px]`}>
                      {(conv.totalTokens ?? 0) > 0 && (
                        <span
                          className="inline-flex items-center gap-0.5"
                          aria-label={`累计 ${formatTokenCount(conv.totalTokens)} tokens`}
                        >
                          <Hash className="size-2.5" aria-hidden />
                          <span>{formatTokenCount(conv.totalTokens)}</span>
                        </span>
                      )}
                      {(conv.totalTokens ?? 0) > 0 && conv.messageCount > 0 && (
                        <span aria-hidden>·</span>
                      )}
                      {conv.messageCount > 0 && (
                        <span>{conv.messageCount} 条消息</span>
                      )}
                    </div>
                  )}
                </div>
                {(isMobile || hoveredId === conv.id) && (
                  <div className={`${styles.sidebarActionGradient} pointer-events-none absolute inset-y-1 right-1 flex items-center gap-0.5 pl-6 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity duration-150`}>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        startRename(conv)
                      }}
                      className={`${styles.actionButton} pointer-events-auto p-1.5`}
                      aria-label="重命名"
                    >
                      <Pencil className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDeleteWithAnimation(conv.id)
                      }}
                      className={`${styles.actionButton} ${styles.dangerAction} pointer-events-auto p-1.5`}
                      aria-label="删除"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        ))}
      </div>

      {/* Footer */}
      {conversations.length > 0 && (
        <div className={`${styles.sidebarFooter} px-4 py-3 border-t`}>
          <p className={`${styles.sidebarTitle} text-[10px] text-center`}>{conversations.length} 个对话</p>
        </div>
      )}
      </div>
    </div>
  )
}
