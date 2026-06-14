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
} from 'lucide-react'
import type { Conversation } from './types'

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
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const editRef = useRef<HTMLInputElement>(null)
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  useEffect(() => {
    if (editingId && editRef.current) {
      editRef.current.focus()
      editRef.current.select()
    }
  }, [editingId])

  // ── GSAP: Hover on conversation items ────────────────────────────
  useGSAP(
    () => {
      if (hoveredId) {
        const el = itemRefs.current.get(hoveredId)
        if (el) {
          gsap.to(el, {
            x: 3,
            backgroundColor: 'rgba(255,255,255,0.04)',
            duration: 0.2,
            ease: 'none',
          })
        }
      } else {
        itemRefs.current.forEach((el) => {
          gsap.to(el, { x: 0, backgroundColor: 'transparent', duration: 0.2 })
        })
      }
    },
    { scope: itemRefs }
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
      className="absolute inset-y-0 left-0 z-40 flex flex-col border-r border-white/[0.08] pointer-events-auto"
      style={{
        width: 'var(--sidebar-width, 280px)',
        background: 'linear-gradient(180deg, #141416 0%, #111113 100%)',
        backdropFilter: 'blur(16px)',
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-4 pt-4 pb-3 border-b border-white/[0.06]">
        <div className="min-w-0 flex-1 pr-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs font-semibold uppercase tracking-[0.2em] text-[#5a5a5f]">
              对话历史
            </span>
            <span className="shrink-0 rounded-full bg-white/[0.04] px-2 py-0.5 text-[10px] font-medium text-[#5a5a5f]">
              自动保存
            </span>
          </div>
          <p className="mt-1 truncate text-[10px] leading-4 text-[#505056]">
            全部会话会自动保存
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => {
              const btn = document.querySelector('.conv-new-btn')
              if (btn) gsap.fromTo(btn, { scale: 0.8 }, { scale: 1, duration: 0.3, ease: 'back.out(2)' })
              onCreate()
            }}
            className="conv-new-btn flex items-center justify-center size-8 rounded-lg bg-white/[0.06] text-[#8a8a8f] hover:text-white hover:bg-white/[0.1] transition-all duration-200 active:scale-95"
            aria-label="新建对话"
          >
            <Plus className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              const el = document.querySelector('[data-sidebar]')
              if (el) gsap.to(el, { opacity: 0, x: -280, duration: 0.25, ease: 'power2.in', onComplete: onClose })
            }}
            className="flex items-center justify-center size-8 rounded-lg text-[#5a5a5f] hover:text-white hover:bg-white/[0.06] transition-all duration-200 active:scale-95"
            aria-label="关闭侧边栏"
          >
            <PanelLeftClose className="size-4" />
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="px-3 pt-3 pb-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-[#5a5a5f] pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索对话..."
            className="w-full rounded-lg bg-white/[0.04] border border-white/[0.06] pl-8 pr-3 py-2 text-[13px] text-white placeholder-[#4a4a4f] outline-none focus:border-white/[0.12] transition-colors"
          />
        </div>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5" data-sidebar>
        {filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <MessageSquare className="size-8 text-[#3a3a3f] mb-3" />
            <p className="text-xs text-[#5a5a5f]">
              {searchQuery ? '没有匹配的对话' : '还没有对话'}
            </p>
            {!searchQuery && (
              <button
                type="button"
                onClick={onCreate}
                className="mt-3 text-xs text-[#1488fc] hover:text-[#4da6ff] transition-colors"
              >
                开始新对话
              </button>
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
                if (el) gsap.fromTo(el, { scale: 0.98 }, { scale: 1, duration: 0.15, ease: 'power2.out' })
                onSelect(conv.id)
              }
            }}
            onMouseEnter={() => setHoveredId(conv.id)}
            onMouseLeave={() => setHoveredId(null)}
            className={`group flex items-center gap-3 px-3 py-2.5 rounded-xl cursor-pointer transition-all duration-200 ${
              activeId === conv.id
                ? 'bg-white/[0.08] text-white'
                : 'text-[#a0a0a5] hover:text-white'
            }`}
          >
            <MessageSquare className="size-4 shrink-0 opacity-60" />

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
                  className="flex-1 min-w-0 rounded-md bg-white/[0.06] border border-white/[0.12] px-2 py-1 text-[13px] text-white outline-none focus:border-[#1488fc] transition-colors"
                />
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    commitRename()
                  }}
                  className="shrink-0 p-1 rounded-md text-[#1488fc] hover:text-[#4da6ff] hover:bg-white/[0.08] transition-colors"
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
                  className="shrink-0 p-1 rounded-md text-[#5a5a5f] hover:text-white hover:bg-white/[0.08] transition-colors"
                  aria-label="取消重命名"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ) : (
              <>
                <span className="flex-1 min-w-0 text-[13px] font-medium truncate">
                  {conv.title}
                </span>
                {/* Right column reserves a stable 56px slot for the hover
                    actions so the title never gets pushed around when the
                    user moves the cursor in / out. */}
                <div className="shrink-0 w-14 flex items-center justify-end gap-0.5">
                  {hoveredId === conv.id ? (
                    <>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          startRename(conv)
                        }}
                        className="p-1 rounded-md text-[#5a5a5f] hover:text-white hover:bg-white/[0.08] transition-colors"
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
                        className="p-1 rounded-md text-[#5a5a5f] hover:text-red-400 hover:bg-red-400/[0.08] transition-colors"
                        aria-label="删除"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </>
                  ) : null}
                </div>
              </>
            )}
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-white/[0.06]">
        <p className="text-[10px] text-[#3a3a3f] text-center">
          {conversations.length} 个对话
        </p>
      </div>
    </div>
  )
}
