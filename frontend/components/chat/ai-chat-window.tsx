'use client'

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import { AlertTriangle, PanelLeft, Square } from 'lucide-react'

import { animationStyles } from './constants/animation-styles'
import { TypewriterText } from './typewriter-text'
import { ChatInput } from './chat-input'
import { RayBackground } from './ray-background'
import { AnnouncementBadge } from './announcement-badge'
import { FloatingParticles } from './floating-particles'
import { ChatMessageList } from './chat-message-list'
import { ConversationSidebar } from './conversation-sidebar'
import { SuggestionChips } from './suggestion-chips'
import {
  useChatStreamV2,
  type UseChatStreamCallbacks,
  type ChatStreamOptions,
} from './hooks/use-chat-stream-v2'

import { ensureConfigLoaded, getConfig } from '@/lib/api/ai-chat-config-store'
import {
  createConversation,
  deleteConversation,
  deleteMessage,
  editMessage,
  getMessages,
  listConversations,
  renameConversation,
  type ServerChatMessage,
  type ServerConversation,
} from '@/lib/api/ai-chat'
import { useMobile } from '@/lib/hooks/use-mobile'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import styles from './warm-chat.module.css'

import type { TextSegment, ChatMessage, Phase, AIChatWindowProps, Conversation } from './types'

// ── Mappers ───────────────────────────────────────────────────────────────

/** Map a backend conversation to a UI `Conversation` (id uses server id). */
function toClientConversation(server: ServerConversation): Conversation {
  return {
    id: `server-${server.id}`,
    serverId: server.id,
    title: server.title || '新对话',
    createdAt: new Date(server.created_at).getTime(),
    updatedAt: new Date(server.updated_at).getTime(),
    messageCount: 0,
    // 后端已累计：ui 显示累计 token 总量（在侧边栏小 chip）
    totalTokens: server.total_tokens,
    totalPromptTokens: server.total_prompt_tokens,
    totalCompletionTokens: server.total_completion_tokens,
  }
}

/** Map a backend message to a UI `ChatMessage`. */
function toClientMessage(server: ServerChatMessage): ChatMessage {
  const isAssistant = server.role === 'assistant'
  const hasUsage =
    isAssistant &&
    (server.total_tokens > 0 || server.prompt_tokens > 0 || server.completion_tokens > 0)
  return {
    id: `server-${server.id}`,
    serverId: server.id,
    role: isAssistant ? 'assistant' : 'user',
    content: server.content,
    streaming: false,
    searchSources: server.search_sources,
    // [BEL-81.B] 历史回放用：让 chip 在刷新后仍可见
    searchTimeRange: server.search_time_range ?? null,
    tokenUsage: hasUsage
      ? {
          prompt: server.prompt_tokens,
          completion: server.completion_tokens,
          total: server.total_tokens,
        }
      : undefined,
    durationMs: isAssistant ? (server.duration_ms ?? undefined) : undefined,
    createdAt: server.created_at,
  }
}

export function AIChatWindow({
  announcementText = 'BelieveBoy AI 助手',
  announcementHref = '#',
  placeholder = '输入消息，开始对话...',
  showInput = true,
  onSend,
}: AIChatWindowProps) {
  const [phase, setPhase] = useState<Phase>('landing')
  const [arcsUp, setArcsUp] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [showSidebar, setShowSidebar] = useState(false)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConvId, setActiveConvId] = useState<string | null>(null)
  const [activeServerId, setActiveServerId] = useState<number | null>(null)
  const [loadingConversations, setLoadingConversations] = useState(false)
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [refreshingPageData, setRefreshingPageData] = useState(false)
  const [pageRefreshError, setPageRefreshError] = useState<string | null>(null)
  const [providerConfigured, setProviderConfigured] = useState<boolean | null>(null)
  const [streamError, setStreamError] = useState<string | null>(null)
  /** Bumped to force re-fetching the conversation list (after create/delete/rename). */
  const [refreshKey, setRefreshKey] = useState(0)
  const refreshConversations = useCallback(() => setRefreshKey((k) => k + 1), [])
  const [enableWebSearch, setEnableWebSearch] = useState(false)
  const [reasoningEffort, setReasoningEffort] = useState<string | null>(null)
  const [selectedModel, setSelectedModel] = useState<string | undefined>(undefined)
  const isMobile = useMobile()

  const rootRef = useRef<HTMLDivElement>(null)
  const sidebarRef = useRef<HTMLDivElement>(null)
  const sidebarToggleRef = useRef<HTMLButtonElement>(null)
  const stopBtnRef = useRef<HTMLButtonElement>(null)
  const chatScrollRef = useRef<HTMLDivElement>(null)
  const stopBtnShownRef = useRef(false)
  // Ref-based conversation ID so useChatStream always reads the latest value
  // (fixes the bug where landing→chat creates the conversation inside a
  // setTimeout but sendStream was captured with conversationId=0).
  const activeServerIdRef = useRef<number | null>(null)
  const closeSidebar = useCallback(() => {
    setShowSidebar(false)
    requestAnimationFrame(() => sidebarToggleRef.current?.focus({ preventScroll: true }))
  }, [])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const clear = () => root.style.setProperty('--chat-keyboard-inset', '0px')
    if (!isMobile || !window.visualViewport) {
      clear()
      return
    }
    const visualViewport = window.visualViewport
    const update = () => {
      const inset = Math.max(
        0,
        window.innerHeight - visualViewport.height - visualViewport.offsetTop
      )
      root.style.setProperty('--chat-keyboard-inset', `${Math.round(inset)}px`)
    }
    update()
    visualViewport.addEventListener('resize', update)
    visualViewport.addEventListener('scroll', update)
    return () => {
      visualViewport.removeEventListener('resize', update)
      visualViewport.removeEventListener('scroll', update)
      clear()
    }
  }, [isMobile])

  // Keep ref in sync with state
  useEffect(() => {
    activeServerIdRef.current = activeServerId
  }, [activeServerId])

  useEffect(() => {
    if (!showSidebar || !isMobile) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeSidebar()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [closeSidebar, isMobile, showSidebar])

  // ── Config: load once on mount so the top-level "AI Provider 未配置" hint
  // ── can render as soon as the user lands on the page. Components like
  // ── <ModelSelector /> reach into the same store.
  useEffect(() => {
    ensureConfigLoaded()
      .then((cfg) => setProviderConfigured(cfg.providerConfigured))
      .catch(() => setProviderConfigured(false))
  }, [])

  // ── Load conversations whenever refreshKey changes.
  useEffect(() => {
    let cancelled = false
    setLoadingConversations(true)
    listConversations()
      .then((rows) => {
        if (cancelled) return
        const list = rows.map(toClientConversation)
        setConversations(list)
        // Auto-select the most recently updated conversation on first load.
        setActiveConvId((current) => {
          if (current) return current
          if (list.length > 0) {
            const first = [...list].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]
            setActiveServerId(first.serverId ?? null)
            return first.id
          }
          return null
        })
      })
      .catch((err) => {
        if (cancelled) return
        console.error('[ai-chat] listConversations failed', err)
        setConversations([])
      })
      .finally(() => {
        if (!cancelled) setLoadingConversations(false)
      })
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  // ── Sync showSidebar with phase: 首屏默认折叠，聊天页默认展开。
  const phaseSyncRanRef = useRef(false)
  useEffect(() => {
    if (!phaseSyncRanRef.current) {
      phaseSyncRanRef.current = true
      return
    }
    setShowSidebar(!isMobile && phase === 'chat')
  }, [isMobile, phase])

  // ── Load messages whenever the active conversation changes.
  useEffect(() => {
    if (activeServerId == null) {
      setMessages([])
      return
    }
    let cancelled = false
    setLoadingMessages(true)
    getMessages(activeServerId)
      .then((rows) => {
        if (cancelled) return
        setMessages(rows.map(toClientMessage))
      })
      .catch((err) => {
        if (cancelled) return
        console.error('[ai-chat] getMessages failed', err)
        setMessages([])
      })
      .finally(() => {
        if (!cancelled) setLoadingMessages(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeServerId])

  const headerRefreshRequestRef = useRef(0)
  const refreshPageData = useCallback(async () => {
    if (isStreaming) return

    const requestId = ++headerRefreshRequestRef.current
    const targetConversationId = activeServerId
    setRefreshingPageData(true)
    setPageRefreshError(null)

    try {
      const [conversationResult, messageResult, configResult] = await Promise.allSettled([
        listConversations(),
        targetConversationId == null ? Promise.resolve([]) : getMessages(targetConversationId),
        ensureConfigLoaded(true),
      ])
      if (requestId !== headerRefreshRequestRef.current) return

      const errors: string[] = []
      let refreshedConversations: Conversation[] | null = null
      if (conversationResult.status === 'fulfilled') {
        refreshedConversations = conversationResult.value.map(toClientConversation)
        setConversations(refreshedConversations)
      } else {
        errors.push(
          conversationResult.reason instanceof Error
            ? conversationResult.reason.message
            : '加载历史会话失败'
        )
      }

      if (configResult.status === 'fulfilled') {
        setProviderConfigured(configResult.value.providerConfigured)
      } else {
        errors.push(configResult.reason instanceof Error ? configResult.reason.message : '加载 AI 配置失败')
      }

      const targetStillExists =
        targetConversationId == null ||
        refreshedConversations?.some((conversation) => conversation.serverId === targetConversationId) !== false

      if (
        targetConversationId != null &&
        targetConversationId === activeServerIdRef.current &&
        targetStillExists
      ) {
        if (messageResult.status === 'fulfilled') {
          setMessages(messageResult.value.map(toClientMessage))
        } else {
          errors.push(
            messageResult.reason instanceof Error ? messageResult.reason.message : '加载会话消息失败'
          )
        }
      } else if (targetConversationId == null && refreshedConversations && !activeConvId) {
        const latest = [...refreshedConversations].sort(
          (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
        )[0]
        if (latest) {
          setActiveConvId(latest.id)
          setActiveServerId(latest.serverId ?? null)
        }
      } else if (targetConversationId != null && refreshedConversations && !targetStillExists) {
        const latest = [...refreshedConversations].sort(
          (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
        )[0]
        setActiveConvId(latest?.id ?? null)
        setActiveServerId(latest?.serverId ?? null)
        setMessages([])
      }

      setPageRefreshError(errors.length > 0 ? errors.join('；') : null)
    } catch (error) {
      if (requestId === headerRefreshRequestRef.current) {
        setPageRefreshError(error instanceof Error ? error.message : '刷新 AI 会话数据失败')
      }
    } finally {
      if (requestId === headerRefreshRequestRef.current) setRefreshingPageData(false)
    }
  }, [activeConvId, activeServerId, isStreaming])

  useHeaderRefresh(refreshPageData, {
    loading: refreshingPageData || loadingConversations || loadingMessages || isStreaming,
  })

  // ── Chat stream hook — uses ref-based conversation ID so send() always
  // ── resolves to the current server ID, even when the conversation is
  // ── created mid-flow (e.g. landing→chat transition).
  const streamCallbacksRef = useRef<UseChatStreamCallbacks>({})
  const {
    send: sendStream,
    stop: stopStream,
    error: streamHookError,
    toolState,
    pendingSources,
    pendingUsage,
  } = useChatStreamV2(activeServerIdRef, streamCallbacksRef)

  // Surface stream-hook errors as a transient banner.
  useEffect(() => {
    if (streamHookError) setStreamError(streamHookError)
  }, [streamHookError])

  // ── GSAP: Sidebar entrance ──────────────────────────────────────
  useGSAP(
    () => {
      if (sidebarRef.current) {
        gsap.fromTo(
          sidebarRef.current,
          { opacity: 0, x: -280 },
          {
            opacity: 1,
            x: 0,
            duration: 0.35,
            ease: 'power3.out',
          }
        )
      }
    },
    { scope: sidebarRef, dependencies: [showSidebar] }
  )

  // ── GSAP: Stop button ────────────────────────────────────────────
  useGSAP(
    () => {
      if (!stopBtnRef.current) return
      if (isStreaming && !stopBtnShownRef.current) {
        stopBtnShownRef.current = true
        gsap.fromTo(
          stopBtnRef.current,
          { opacity: 0, scale: 0.8, y: 8 },
          { opacity: 1, scale: 1, y: 0, duration: 0.25, ease: 'back.out(2)' }
        )
      } else if (!isStreaming && stopBtnShownRef.current) {
        stopBtnShownRef.current = false
        gsap.to(stopBtnRef.current, {
          opacity: 0,
          scale: 0.9,
          y: -8,
          duration: 0.2,
          ease: 'power2.in',
        })
      }
    },
    { scope: rootRef, dependencies: [isStreaming] }
  )

  // ── Auto-scroll ──────────────────────────────────────────────────
  const messagesEndRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTo({
        top: chatScrollRef.current.scrollHeight,
        behavior: 'smooth',
      })
    }
  }, [messages])

  const isLanding = phase === 'landing'
  const isTransitioning = phase === 'transitioning'
  const isChat = phase === 'chat'
  const hasMessages = messages.length > 0
  // Derived from message data — true if any assistant message in this
  // conversation was produced via web search.
  const usedWebSearch = useMemo(
    () => messages.some((m) => m.role === 'assistant' && (m.searchSources?.length ?? 0) > 0),
    [messages]
  )

  // ── Stream callback bridge ───────────────────────────────────────
  const wireStreamCallbacks = useCallback(
    (assistantLocalId: string, userLocalId?: string) => {
      streamCallbacksRef.current = {
        onStart: () => {
          // No-op — UI already shows the typing indicator.
        },
        onChunk: (delta) => {
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.id === assistantLocalId)
            if (idx === -1) return prev
            const target = prev[idx]
            return [
              ...prev.slice(0, idx),
              { ...target, content: target.content + delta, streaming: true, error: false },
              ...prev.slice(idx + 1),
            ]
          })
        },
        onThinking: (delta) => {
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.id === assistantLocalId)
            if (idx === -1) return prev
            const target = prev[idx]
            return [
              ...prev.slice(0, idx),
              { ...target, thinking: (target.thinking ?? '') + delta },
              ...prev.slice(idx + 1),
            ]
          })
        },
        onSources: (sources, meta) => {
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.id === assistantLocalId)
            if (idx === -1) return prev
            const target = prev[idx]
            return [
              ...prev.slice(0, idx),
              {
                ...target,
                searchSources: sources,
                searchTimeRange: meta?.timeRange ?? target.searchTimeRange ?? null,
                searchQuery: meta?.query ?? target.searchQuery ?? null,
                searchSearching: false,
              },
              ...prev.slice(idx + 1),
            ]
          })
        },
        onToolState: (state) => {
          if (!state.searching) return
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.id === assistantLocalId)
            if (idx === -1) return prev
            const target = prev[idx]
            if (target.searchSearching && target.searchSources && target.searchSources.length > 0) {
              return prev
            }
            return [
              ...prev.slice(0, idx),
              { ...target, searchSearching: true },
              ...prev.slice(idx + 1),
            ]
          })
        },
        onUsage: (usage) => {
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.id === assistantLocalId)
            if (idx === -1) return prev
            const target = prev[idx]
            return [
              ...prev.slice(0, idx),
              {
                ...target,
                tokenUsage: {
                  prompt: usage.prompt_tokens,
                  completion: usage.completion_tokens,
                  total: usage.total_tokens,
                },
              },
              ...prev.slice(idx + 1),
            ]
          })
        },
        onDone: (payload) => {
          setMessages((prev) => {
            const aiIdx = prev.findIndex((m) => m.id === assistantLocalId)
            const userIdx = userLocalId ? prev.findIndex((m) => m.id === userLocalId) : -1
            const persisted = toClientMessage(payload.assistantMessage)
            const persistedUser = toClientMessage(payload.userMessage)
            const next = prev.slice()
            if (userIdx !== -1) {
              next[userIdx] = {
                ...persistedUser,
                content: prev[userIdx].content || persistedUser.content,
              }
            }
            if (aiIdx !== -1) {
              next[aiIdx] = {
                ...persisted,
                content: prev[aiIdx].content || persisted.content,
                streaming: false,
              }
            }
            return next
          })
          setIsStreaming(false)
          refreshConversations()
        },
        onUserMessageId: () => {
          // No-op — reconciliation happens in `onDone`.
        },
        onAssistantId: () => {
          // No-op — reconciliation happens in `onDone`.
        },
        onTitleUpdate: (newTitle) => {
          setConversations((prev) =>
            prev.map((c) => (c.serverId === activeServerId ? { ...c, title: newTitle } : c))
          )
        },
        onError: () => {
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.id === assistantLocalId)
            if (idx === -1) return prev
            const target = prev[idx]
            return [
              ...prev.slice(0, idx),
              { ...target, streaming: false, error: true },
              ...prev.slice(idx + 1),
            ]
          })
          setIsStreaming(false)
        },
      }
    },
    [activeServerId, refreshConversations]
  )

  // ── Stop generation ────────────────────────────────────────────────
  const handleStopGeneration = useCallback(() => {
    stopStream()
    setMessages((prev) => {
      const last = prev[prev.length - 1]
      if (!last || last.role !== 'assistant') return prev
      return [...prev.slice(0, -1), { ...last, streaming: false }]
    })
    setIsStreaming(false)
  }, [stopStream])

  // ── Conversation management ───────────────────────────────────────
  const ensureServerConversation = useCallback(async (): Promise<number | null> => {
    if (activeServerId != null) return activeServerId
    try {
      const created = await createConversation()
      const mapped = toClientConversation(created)
      setConversations((prev) => [mapped, ...prev])
      setActiveConvId(mapped.id)
      setActiveServerId(mapped.serverId ?? null)
      return mapped.serverId ?? null
    } catch (err) {
      console.error('[ai-chat] auto-create conversation failed', err)
      return null
    }
  }, [activeServerId])

  const handleCreateConversation = useCallback(async () => {
    try {
      const created = await createConversation()
      const mapped = toClientConversation(created)
      setConversations((prev) => [mapped, ...prev])
      setActiveConvId(mapped.id)
      setActiveServerId(mapped.serverId ?? null)
      setMessages([])
      setPhase('chat')
      setShowSidebar(false)
    } catch (err) {
      console.error('[ai-chat] createConversation failed', err)
    }
  }, [])

  const handleSelectConversation = useCallback(
    (id: string) => {
      const conv = conversations.find((c) => c.id === id)
      if (!conv) return
      const isCurrentConversation =
        activeServerId !== null && conv.serverId === activeServerId
      setActiveConvId(conv.id)
      setActiveServerId(conv.serverId ?? null)
      if (!isCurrentConversation) setMessages([])
      setPhase('chat')
      setShowSidebar(false)
    },
    [activeServerId, conversations]
  )

  const handleRenameConversation = useCallback(
    async (id: string, title: string) => {
      const conv = conversations.find((c) => c.id === id)
      if (!conv?.serverId) return
      setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)))
      try {
        const updated = await renameConversation(conv.serverId, title)
        setConversations((prev) =>
          prev.map((c) => (c.id === id ? { ...c, title: updated.title || title } : c))
        )
      } catch (err) {
        console.error('[ai-chat] renameConversation failed', err)
        setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title: conv.title } : c)))
      }
    },
    [conversations]
  )

  const handleDeleteConversation = useCallback(
    async (id: string) => {
      const conv = conversations.find((c) => c.id === id)
      if (!conv?.serverId) {
        setConversations((prev) => {
          const filtered = prev.filter((c) => c.id !== id)
          if (filtered.length === 0) return []
          if (activeConvId === id) {
            const next = filtered[0]
            setActiveConvId(next.id)
            setActiveServerId(next.serverId ?? null)
          }
          return filtered
        })
        return
      }
      try {
        await deleteConversation(conv.serverId)
      } catch (err) {
        console.error('[ai-chat] deleteConversation failed', err)
        return
      }
      setConversations((prev) => {
        const filtered = prev.filter((c) => c.id !== id)
        if (activeConvId === id) {
          if (filtered.length === 0) {
            setActiveConvId(null)
            setActiveServerId(null)
            setMessages([])
          } else {
            const next = filtered[0]
            setActiveConvId(next.id)
            setActiveServerId(next.serverId ?? null)
            setMessages([])
          }
        }
        return filtered
      })
    },
    [conversations, activeConvId]
  )

  // ── Message operations ─────────────────────────────────────────────
  const handleRegenerateMessage = useCallback(
    async (messageId: string) => {
      if (activeServerId == null || isStreaming) return
      const target = messages.find((m) => m.id === messageId)
      if (!target?.serverId) return
      const newAssistantId = `assistant-${Date.now()}`
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === messageId)
        if (idx === -1) return prev
        const placeholder: ChatMessage = {
          id: newAssistantId,
          role: 'assistant',
          content: '',
          streaming: true,
        }
        return [...prev.slice(0, idx), placeholder, ...prev.slice(idx + 1)]
      })
      setIsStreaming(true)
      setStreamError(null)
      const cfg = getConfig()
      const model = selectedModel ?? cfg?.defaultModel
      const reasoningSupported = model
        ? (cfg?.reasoningModels ?? []).some((item) => item.toLowerCase() === model.toLowerCase())
        : false
      const options: ChatStreamOptions = {
        model,
        regenerate: true,
        targetMessageId: target.serverId,
        reasoningEffort: reasoningSupported ? reasoningEffort : null,
        enableWebSearch,
      }
      wireStreamCallbacks(newAssistantId)
      try {
        await sendStream('', options)
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          console.error('[ai-chat] regenerate failed', err)
        }
      }
    },
    [
      activeServerId,
      isStreaming,
      messages,
      sendStream,
      wireStreamCallbacks,
      selectedModel,
      reasoningEffort,
      enableWebSearch,
    ]
  )

  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)

  const handleEditMessage = useCallback((messageId: string) => {
    setEditingMessageId(messageId)
  }, [])

  const handleEditSave = useCallback(
    async (messageId: string, newContent: string) => {
      setEditingMessageId(null)
      const target = messages.find((m) => m.id === messageId)
      if (!target?.serverId || activeServerId == null) return
      // Optimistic update
      setMessages((prev) =>
        prev.map((m) => (m.id === messageId ? { ...m, content: newContent } : m))
      )
      try {
        await editMessage(activeServerId, target.serverId, newContent)
      } catch (err) {
        console.error('[ai-chat] editMessage failed', err)
        // Revert on failure
        setMessages((prev) =>
          prev.map((m) => (m.id === messageId ? { ...m, content: target.content } : m))
        )
      }
    },
    [activeServerId, messages]
  )

  const handleEditCancel = useCallback(() => {
    setEditingMessageId(null)
  }, [])

  const handleDeleteMessage = useCallback(
    (messageId: string) => {
      // Collect server IDs before the state update (functional updater can't do async)
      const idx = messages.findIndex((m) => m.id === messageId)
      if (idx === -1) return
      const deleted = messages.slice(idx, idx + 2)
      const serverIdsToDelete = deleted
        .filter((m) => m.serverId != null)
        .map((m) => m.serverId as number)

      // Optimistic UI update
      setMessages((prev) => {
        const i = prev.findIndex((m) => m.id === messageId)
        if (i === -1) return prev
        const pair = prev.slice(i, i + 2)
        if (pair[1] && pair[1].role === 'assistant') {
          return [...prev.slice(0, i), ...prev.slice(i + 2)]
        }
        return prev.filter((m) => m.id !== messageId)
      })

      // Fire real DELETE calls (fire-and-forget; UI already updated)
      if (activeServerId != null) {
        for (const sid of serverIdsToDelete) {
          deleteMessage(activeServerId, sid).catch((err) => {
            console.error('[ai-chat] deleteMessage failed', err)
          })
        }
      }
    },
    [activeServerId, messages]
  )

  // ── Send ──────────────────────────────────────────────────────────
  const handleSend = useCallback(
    async (message: string, streamOptions: ChatStreamOptions = {}) => {
      if (!showInput) return
      onSend?.(message)
      setStreamError(null)

      const userLocalId = `user-${Date.now()}`
      const assistantLocalId = `assistant-${Date.now()}`
      const userMsg: ChatMessage = { id: userLocalId, role: 'user', content: message }
      const assistantMsg: ChatMessage = {
        id: assistantLocalId,
        role: 'assistant',
        content: '',
        streaming: true,
      }

      const enterChat = () => {
        setMessages([userMsg, assistantMsg])
        setIsStreaming(true)
      }

      // Landing → chat: create conversation first (so the ref-based hook
      // has the real server ID), then animate the transition, then send.
      if (phase === 'landing') {
        const serverId = await ensureServerConversation()
        if (serverId == null) {
          setIsStreaming(false)
          return
        }
        // The ref is now pointing at the real serverId because
        // ensureServerConversation set activeServerId which synced the ref.
        setPhase('transitioning')
        setArcsUp(true)
        // Animate for 600ms, then flip to chat and stream.
        setTimeout(() => {
          setPhase('chat')
          enterChat()
          wireStreamCallbacks(assistantLocalId, userLocalId)
          const cfg = getConfig()
          const model = selectedModel ?? cfg?.defaultModel
          const reasoningSupported = model
            ? (cfg?.reasoningModels ?? []).some(
                (item) => item.toLowerCase() === model.toLowerCase()
              )
            : false
          sendStream(message, {
            enableWebSearch: streamOptions.enableWebSearch ?? false,
            ...streamOptions,
            model,
            reasoningEffort: reasoningSupported
              ? (streamOptions.reasoningEffort ?? reasoningEffort)
              : null,
          }).catch((err) => {
            if (!(err instanceof DOMException && err.name === 'AbortError')) {
              console.error('[ai-chat] send failed', err)
            }
          })
        }, 600)
        return
      }

      // Mid-chat: conversation should already exist.
      enterChat()
      wireStreamCallbacks(assistantLocalId, userLocalId)
      const cfg = getConfig()
      const model = selectedModel ?? cfg?.defaultModel
      const reasoningSupported = model
        ? (cfg?.reasoningModels ?? []).some((item) => item.toLowerCase() === model.toLowerCase())
        : false
      sendStream(message, {
        enableWebSearch: streamOptions.enableWebSearch ?? false,
        ...streamOptions,
        model,
        reasoningEffort: reasoningSupported
          ? (streamOptions.reasoningEffort ?? reasoningEffort)
          : null,
      }).catch((err) => {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          console.error('[ai-chat] send failed', err)
        }
      })
    },
    [
      showInput,
      onSend,
      phase,
      ensureServerConversation,
      sendStream,
      wireStreamCallbacks,
      reasoningEffort,
      selectedModel,
    ]
  )

  // ── Handle suggestion chip clicks ────────────────────────────────
  const handleSuggestionClick = useCallback(
    (prompt: string) => {
      handleSend(prompt, {
        enableWebSearch:
          prompt.toLowerCase().includes('数据') || prompt.toLowerCase().includes('趋势'),
      })
    },
    [handleSend]
  )

  return (
    <div
      ref={rootRef}
      data-testid="ai-chat-window"
      data-warm-surface="warm-ledger"
      className={`${styles.window} warm-ledger relative h-full w-full overflow-hidden safe-area-inset-top safe-area-inset-bottom`}
      style={{ ['--sidebar-width' as string]: '280px' }}
    >
      <style dangerouslySetInnerHTML={{ __html: animationStyles }} />

      {pageRefreshError && (
        <div role="alert" className={`${styles.alert} absolute left-1/2 top-4 z-[60] -translate-x-1/2 px-3 py-2 text-xs`}>
          历史会话刷新失败：{pageRefreshError}
        </div>
      )}

      {/* Layer 1: Background */}
      <div
        className="absolute inset-0"
        style={{
          paddingLeft: !isMobile && showSidebar ? 'var(--sidebar-width, 280px)' : '0px',
          transition: 'padding-left var(--duration-medium) var(--ease-smooth-out)',
        }}
      >
        <RayBackground arcsUp={arcsUp} />
        <FloatingParticles />
      </div>

      {/* Sidebar toggle */}
      {showInput && !showSidebar && (
        <button
          ref={sidebarToggleRef}
          type="button"
          onClick={() => setShowSidebar(true)}
          className={`${styles.sidebarToggle} absolute top-4 left-16 md:left-4 z-30 size-10`}
          aria-label="打开对话历史"
        >
          <PanelLeft className="size-4" />
        </button>
      )}

      {/* Provider-unconfigured banner */}
      {showInput && providerConfigured === false && (
        <div className="absolute left-1/2 top-4 z-30 -translate-x-1/2 w-full max-w-[680px] px-3 sm:px-4">
          <div className={`${styles.providerBanner} flex items-start gap-2 px-3 py-2 text-xs`}>
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <div>
              <p className="font-medium">后端 AI Provider 未配置</p>
              <p className="mt-0.5 text-amber-200/70">
                请在 <code className="rounded bg-amber-500/10 px-1">backend/.env</code> 配置{' '}
                <code className="rounded bg-amber-500/10 px-1">AI_CHAT_PROVIDER_API_KEY</code>{' '}
                后重启后端服务。
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Layer 2: Sidebar */}
      {showSidebar && (
        <div ref={sidebarRef} className="pointer-events-none absolute inset-0 z-40">
          {isMobile ? (
            <button
              type="button"
              className={styles.sidebarScrim}
              aria-label="关闭对话历史"
              data-testid="ai-chat-sidebar-scrim"
              onClick={closeSidebar}
            />
          ) : null}
          <ConversationSidebar
            conversations={conversations}
            activeId={activeConvId}
            onSelect={handleSelectConversation}
            onCreate={handleCreateConversation}
            onRename={handleRenameConversation}
            onDelete={handleDeleteConversation}
            onClose={closeSidebar}
          />
        </div>
      )}

      {/* Layer 3: Landing — redesigned welcome screen */}
      <div
        className="absolute inset-0 flex flex-col items-center transition-opacity duration-500"
        style={{
          opacity: isLanding ? 1 : 0,
          pointerEvents: isLanding ? 'auto' : 'none',
        }}
      >
        <div className="absolute top-[60px] sm:top-[70px]">
          <AnnouncementBadge text={announcementText} href={announcementHref} />
        </div>

        {/* Greeting + suggestion chips — positioned between top badge and input */}
        <div className="absolute left-1/2 top-[22%] -translate-x-1/2 w-full max-w-[600px] px-6 sm:px-4">
          <div className="text-center mb-6 sm:mb-8">
            <h1 className={styles.landingTitle}>
              <TypewriterText
                segments={[
                  { text: '今天想', speed: 80 },
                  { text: '分析', highlight: true, speed: 100 },
                  { text: '什么？', speed: 80 },
                ]}
                rollingWords={[
                  '分析',
                  '发现',
                  '探索',
                  '学习',
                  '构建',
                  '理解',
                  '洞察',
                  '预测',
                  '拆解',
                  '复盘',
                ]}
                startDelay={500}
              />
            </h1>
            <p
              className={`${styles.landingSubtitle} mt-3 text-sm sm:text-base bb-anim-fade-up`}
              style={{ animationDelay: '2.5s' }}
            >
              用 AI 探索数据 — 销售趋势、运营指标、异常洞察
            </p>
          </div>

          {/* Suggestion chips — animated entrance */}
          <SuggestionChips onSelect={handleSuggestionClick} />
        </div>
      </div>

      {/* Layer 4: Chat messages */}
      {(hasMessages || loadingMessages) && (
        <div
          ref={chatScrollRef}
          className={`absolute inset-0 overflow-y-auto overscroll-contain ${
            isChat ? 'bb-chat-enter' : 'invisible'
          }`}
          style={{
            paddingLeft: !isMobile && showSidebar ? 'var(--sidebar-width, 280px)' : '0px',
            paddingTop: 'env(safe-area-inset-top, 16px)',
            paddingBottom: isMobile
              ? 'calc(168px + var(--chat-keyboard-inset, 0px) + env(safe-area-inset-bottom, 16px))'
              : 'calc(120px + env(safe-area-inset-bottom, 16px))',
            transition: 'padding-left var(--duration-medium) var(--ease-smooth-out)',
          }}
        >
          <div className="px-3 sm:px-4 pt-6 pb-4">
            {loadingMessages ? (
              <div className="mx-auto max-w-3xl space-y-4">
                <div className="flex gap-3">
                  <div className={`${styles.skeleton} h-8 w-8 rounded-full`} />
                  <div className="flex-1 space-y-2">
                    <div className={`${styles.skeleton} h-4 w-3/4`} />
                    <div className={`${styles.skeleton} h-4 w-2/3`} />
                  </div>
                </div>
                <div className="flex gap-3">
                  <div className={`${styles.skeleton} h-8 w-8 rounded-full`} />
                  <div className="flex-1 space-y-2">
                    <div className={`${styles.skeleton} h-4 w-1/2`} />
                  </div>
                </div>
              </div>
            ) : (
              <ChatMessageList
                messages={messages}
                onRegenerate={handleRegenerateMessage}
                onEdit={handleEditMessage}
                onDelete={handleDeleteMessage}
                editingMessageId={editingMessageId}
                onEditSave={handleEditSave}
                onEditCancel={handleEditCancel}
                streamError={streamError}
                pendingSearchState={
                  toolState ? { searching: toolState.searching, sources: pendingSources } : null
                }
                pendingUsage={pendingUsage}
                usedWebSearch={usedWebSearch}
                onRetry={
                  messages.length >= 2 && isStreaming === false
                    ? () => {
                        const last = messages[messages.length - 1]
                        if (!last) return
                        if (last.serverId) {
                          handleRegenerateMessage(last.id)
                          return
                        }
                        const userMsg = [...messages].reverse().find((m) => m.role === 'user')
                        if (userMsg) handleRegenerateMessage(userMsg.id)
                      }
                    : undefined
                }
              />
            )}

            {loadingConversations && conversations.length === 0 && !loadingMessages && (
              <div className="mx-auto max-w-3xl mt-2">
                <p className={`${styles.loadingText} text-xs`}>正在加载历史会话…</p>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>
      )}

      {/* Layer 5: Input */}
      {showInput && (
        <div
          className="absolute left-0 right-0 w-full px-3 sm:px-4 pointer-events-none"
          style={{
            paddingLeft: !isMobile && showSidebar ? 'var(--sidebar-width, 280px)' : '0px',
            ...(isLanding || isTransitioning
              ? { top: '58%', transform: 'translateY(-50%)' }
              : {
                  bottom: '0',
                  paddingBottom: 'env(safe-area-inset-bottom, 16px)',
                  transform: isMobile
                    ? 'translateY(calc(-1 * var(--chat-keyboard-inset, 0px)))'
                    : undefined,
                }),
            transition:
              'padding-left var(--duration-medium) var(--ease-smooth-out), top 0.6s var(--ease-smooth-out), bottom 0.6s var(--ease-smooth-out)',
            zIndex: 40,
          }}
        >
          <div className="relative w-full max-w-[680px] mx-auto pointer-events-auto">
            {/* Stop button */}
            <div className="absolute -top-14 left-1/2 -translate-x-1/2" style={{ opacity: 0 }}>
              <button
                ref={stopBtnRef}
                type="button"
                onClick={handleStopGeneration}
                className={`${styles.stopButton} gap-2 px-4 py-2`}
                style={{
                  animation: isStreaming ? 'bb-stop-pulse 1.5s ease-in-out infinite' : 'none',
                }}
                aria-label="停止生成"
              >
                <Square className="size-3 fill-current" />
                <span className="text-xs font-medium">停止生成</span>
              </button>
            </div>

            <ChatInput
              placeholder={isLanding ? placeholder : '继续对话...'}
              onSend={(msg, opts) =>
                handleSend(msg, {
                  ...opts,
                  enableWebSearch,
                  model: selectedModel,
                })
              }
              compact={!isLanding}
              disabled={isStreaming}
              enableWebSearch={enableWebSearch}
              onToggleWebSearch={setEnableWebSearch}
              reasoningEffort={reasoningEffort}
              onReasoningEffortChange={setReasoningEffort}
              selectedModel={selectedModel}
              onModelChange={setSelectedModel}
            />
          </div>
        </div>
      )}
    </div>
  )
}
