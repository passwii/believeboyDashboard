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
import { useChatStream, type UseChatStreamCallbacks, type ChatStreamOptions } from './hooks/use-chat-stream'

import {
  ensureConfigLoaded,
  getConfig,
} from '@/lib/api/ai-chat-config-store'
import {
  createConversation,
  deleteConversation,
  getMessages,
  listConversations,
  renameConversation,
  type ServerChatMessage,
  type ServerConversation,
} from '@/lib/api/ai-chat'
import { Skeleton } from '@/components/ui/skeleton'

import type {
  TextSegment,
  ChatMessage,
  Phase,
  AIChatWindowProps,
  Conversation,
} from './types'

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
    tokenUsage: hasUsage
      ? {
          prompt: server.prompt_tokens,
          completion: server.completion_tokens,
          total: server.total_tokens,
        }
      : undefined,
    durationMs: isAssistant ? server.duration_ms ?? undefined : undefined,
    createdAt: server.created_at,
  }
}

export function AIChatWindow({
  title = '今天你想',
  titleHighlight = '构建',
  subtitle = '从今天出发，用 AI Agent 创造新高度',
  announcementText = 'BelieveBoy AI 助手',
  announcementHref = '#',
  placeholder = '你想构建什么？',
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
  const [providerConfigured, setProviderConfigured] = useState<boolean | null>(null)
  const [streamError, setStreamError] = useState<string | null>(null)
  /** Bumped to force re-fetching the conversation list (after create/delete/rename). */
  const [refreshKey, setRefreshKey] = useState(0)
  const refreshConversations = useCallback(() => setRefreshKey((k) => k + 1), [])
  /**
   * Server-persisted message ids the user has deleted client-side.
   * Backend has no message-level DELETE endpoint yet (see TODO below); we
   * remember deletes locally so a refresh / conversation switch doesn't
   * resurrect messages the user has already dismissed.
   * Keyed by conversation serverId so different conversations stay isolated.
   */
  const [locallyDeletedIds, setLocallyDeletedIds] = useState<Record<number, Set<number>>>({})

  const [enableWebSearch, setEnableWebSearch] = useState(false)
  const [reasoningEffort, setReasoningEffort] = useState<string | null>(null)
  const [selectedModel, setSelectedModel] = useState<string | undefined>(undefined)

  const rootRef = useRef<HTMLDivElement>(null)
  const sidebarRef = useRef<HTMLDivElement>(null)
  const stopBtnRef = useRef<HTMLButtonElement>(null)
  const chatScrollRef = useRef<HTMLDivElement>(null)
  const stopBtnShownRef = useRef(false)

  // ── Config: load once on mount so the top-level "AI Provider 未配置" hint
  // ── can render as soon as the user lands on the page. Components like
  // ── <ModelSelector /> reach into the same store.
  useEffect(() => {
    ensureConfigLoaded()
      .then((cfg) => setProviderConfigured(cfg.providerConfigured))
      .catch(() => setProviderConfigured(false))
  }, [])

  // ── Load conversations whenever refreshKey changes. We don't use the
  // ── `useApiQuery` hook because (a) it caps at 5s timeout which is too
  // ── short for an initial conversation list, and (b) we want fine-grained
  // ── control over the empty-state UX (the chat window stays usable even
  // ── before the list arrives).
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
  // ── Users can still toggle manually; the next phase transition re-syncs.
  // ── We use a ref to skip the very first run so the initial phase value
  // ── (landing) sets showSidebar=false without flashing.
  const phaseSyncRanRef = useRef(false)
  useEffect(() => {
    if (!phaseSyncRanRef.current) {
      phaseSyncRanRef.current = true
      return
    }
    setShowSidebar(phase === 'chat')
  }, [phase])

  // ── Load messages whenever the active conversation changes.
  useEffect(() => {
    if (activeServerId == null) {
      setMessages([])
      return
    }
    let cancelled = false
    setLoadingMessages(true)
    const hiddenForConv = locallyDeletedIds[activeServerId] ?? new Set<number>()
    getMessages(activeServerId)
      .then((rows) => {
        if (cancelled) return
        const mapped = rows.map(toClientMessage)
        // Filter out messages the user deleted in a previous session —
        // backend still has them, but we treat the local delete as sticky.
        const visible = hiddenForConv.size > 0
          ? mapped.filter((m) => m.serverId == null || !hiddenForConv.has(m.serverId))
          : mapped
        setMessages(visible)
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
  }, [activeServerId, locallyDeletedIds])

  // ── Chat stream hook (only mounted when we have a real server-side
  // ── conversation; the placeholder "new conversation" state creates one
  // ── first via `createConversation`).
  const streamCallbacksRef = useRef<UseChatStreamCallbacks>({})
  const { send: sendStream, stop: stopStream, error: streamHookError } = useChatStream(
    activeServerId ?? 0,
    streamCallbacksRef,
  )

  // Surface stream-hook errors as a transient banner. The hook's `error`
  // state is cleared on the next `send`, so this naturally re-syncs.
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
  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTo({
        top: chatScrollRef.current.scrollHeight,
        behavior: 'smooth',
      })
    }
  }, [messages])

  const isLanding = phase === 'landing'
  const isChat = phase === 'chat'
  const hasMessages = messages.length > 0

  // ── Stream callback bridge: route events into the React state for the
  // ── active assistant message. The assistant message is identified by a
  // ── temporary local id; once the `done` event arrives we replace it
  // ── with the persisted server id so message actions can reference it.
  //
  // For regenerate flows there is no corresponding optimistic user message,
  // so `userLocalId` is optional. When omitted, the `onDone` handler skips
  // the user-message reconciliation step.
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
        onSources: (sources) => {
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.id === assistantLocalId)
            if (idx === -1) return prev
            const target = prev[idx]
            return [
              ...prev.slice(0, idx),
              { ...target, searchSources: sources },
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
          // Replace the optimistic placeholder with the persisted message —
          // same role, real server id, real content (in case any trailing
          // chunk arrived after `done`).
          setMessages((prev) => {
            const aiIdx = prev.findIndex((m) => m.id === assistantLocalId)
            const userIdx = userLocalId ? prev.findIndex((m) => m.id === userLocalId) : -1
            const persisted = toClientMessage(payload.assistantMessage)
            const persistedUser = toClientMessage(payload.userMessage)
            const next = prev.slice()
            if (userIdx !== -1) {
              next[userIdx] = { ...persistedUser, content: prev[userIdx].content || persistedUser.content }
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
          // Bump the conversation list so the title / updatedAt reflect the
          // newly-committed turn (and any regenerated title).
          refreshConversations()
        },
        onUserMessageId: () => {
          // The user message's local id stays — we already display its
          // content. We only refresh the conversation list on the assistant
          // id below.
        },
        onAssistantId: () => {
          // The reconciliation happens in `onDone`; nothing to do here.
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
    [activeServerId, refreshConversations],
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

  const handleSelectConversation = useCallback((id: string) => {
    const conv = conversations.find((c) => c.id === id)
    if (!conv) return
    setActiveConvId(conv.id)
    setActiveServerId(conv.serverId ?? null)
    setMessages([])
    setPhase('chat')
    setShowSidebar(false)
  }, [conversations])

  const handleRenameConversation = useCallback(
    async (id: string, title: string) => {
      const conv = conversations.find((c) => c.id === id)
      if (!conv?.serverId) return
      // Optimistic update — the rename is fire-and-forget from the UI's POV.
      setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)))
      try {
        const updated = await renameConversation(conv.serverId, title)
        setConversations((prev) =>
          prev.map((c) => (c.id === id ? { ...c, title: updated.title || title } : c))
        )
      } catch (err) {
        console.error('[ai-chat] renameConversation failed', err)
        // Roll back on failure.
        setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title: conv.title } : c)))
      }
    },
    [conversations]
  )

  const handleDeleteConversation = useCallback(
    async (id: string) => {
      const conv = conversations.find((c) => c.id === id)
      if (!conv?.serverId) {
        // Pure-local conversation — just drop it from the list.
        setConversations((prev) => {
          const filtered = prev.filter((c) => c.id !== id)
          if (filtered.length === 0) {
            return []
          }
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
  // Regenerate: re-stream the assistant message by pointing at its
  // `serverId`. The user content is irrelevant — backend reads from history.
  const handleRegenerateMessage = useCallback(
    async (messageId: string) => {
      if (activeServerId == null || isStreaming) return
      const target = messages.find((m) => m.id === messageId)
      if (!target?.serverId) return
      const newAssistantId = `assistant-${Date.now()}`
      // Replace the assistant message with a fresh placeholder
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === messageId)
        if (idx === -1) return prev
        const placeholder: ChatMessage = {
          id: newAssistantId,
          role: 'assistant',
          content: '',
          streaming: true,
        }
        return [
          ...prev.slice(0, idx),
          placeholder,
          ...prev.slice(idx + 1),
        ]
      })
      setIsStreaming(true)
      setStreamError(null)
      // Forward the user's current model / reasoning / web-search choices to
      // the regenerated stream — same as `handleSend` does.
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
        // The hook already pushed the error to onError; nothing more to do.
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

  // Edit / Delete on individual messages are TODO — the backend has no
  // message-level endpoint yet. We perform a local-only remove so the UI
  // stays consistent in the meantime.
  const handleEditMessage = useCallback((_messageId: string) => {
    // TODO: wire to a real PATCH /messages/{id} once the backend ships it.
  }, [])

  const handleDeleteMessage = useCallback((messageId: string) => {
    // Drop the message (and the following assistant message if paired) from
    // the local list, then record the deleted server-side ids in
    // `locallyDeletedIds` so a refresh / conversation re-load doesn't bring
    // them back. The conversation-level cache key keeps the list scoped —
    // we never want a delete in conversation A to hide a message in B that
    // happens to share an id (won't happen today, but defensive).
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === messageId)
      if (idx === -1) return prev
      const deleted = prev.slice(idx, idx + 2)
      const idsToHide: number[] = []
      for (const m of deleted) {
        if (m.serverId != null) idsToHide.push(m.serverId)
      }
      if (idsToHide.length > 0 && activeServerId != null) {
        setLocallyDeletedIds((prevDeleted) => {
          const existing = prevDeleted[activeServerId] ?? new Set<number>()
          const next = new Set(existing)
          for (const id of idsToHide) next.add(id)
          return { ...prevDeleted, [activeServerId]: next }
        })
      }
      // If the deleted message is followed by an assistant message, drop
      // the pair (mirrors the pre-refactor behavior). Otherwise just
      // remove the single message.
      if (deleted[1] && deleted[1].role === 'assistant') {
        return [...prev.slice(0, idx), ...prev.slice(idx + 2)]
      }
      // TODO: server-side delete once the backend adds the endpoint.
      return prev.filter((m) => m.id !== messageId)
    })
  }, [activeServerId])

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

      const ensureServerConversation = async (): Promise<number | null> => {
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
      }

      // Landing → chat transition
      if (phase === 'landing') {
        setPhase('transitioning')
        setArcsUp(true)
        // Wait for the transition animation before flipping to `chat`
        // and kicking off the request. We can't `await` GSAP from here
        // cleanly, so use a fixed 800ms (matches the previous build).
        setTimeout(async () => {
          setPhase('chat')
          const serverId = await ensureServerConversation()
          if (serverId == null) {
            setIsStreaming(false)
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantLocalId ? { ...m, streaming: false, error: true } : m
              )
            )
            return
          }
          // Re-mount the stream hook with the new server id by triggering a
          // state update — useChatStream is recreated by the parent
          // component. Easiest path: bump activeServerId, then call
          // sendStream in a microtask.
          enterChat()
          wireStreamCallbacks(assistantLocalId, userLocalId)
          const cfg = getConfig()
          try {
            const model = selectedModel ?? cfg?.defaultModel
            const reasoningSupported = model
              ? (cfg?.reasoningModels ?? []).some((item) => item.toLowerCase() === model.toLowerCase())
              : false
            await sendStream(message, {
              enableWebSearch: streamOptions.enableWebSearch ?? false,
              ...streamOptions,
              model,
              reasoningEffort: reasoningSupported ? (streamOptions.reasoningEffort ?? reasoningEffort) : null,
            })
          } catch (err) {
            if (!(err instanceof DOMException && err.name === 'AbortError')) {
              console.error('[ai-chat] send failed', err)
            }
          }
        }, 800)
        return
      }

      // Mid-chat: if there is no server-side conversation yet (e.g. user
      // clicked a brand-new sidebar entry that hasn't been created on the
      // backend), create one before sending.
      let serverId = activeServerId
      if (serverId == null) {
        const created = await ensureServerConversation()
        if (created == null) {
          setMessages((prev) => [
            ...prev,
            { ...userMsg },
            { ...assistantMsg, streaming: false, error: true },
          ])
          setIsStreaming(false)
          return
        }
        serverId = created
      }
      enterChat()
      wireStreamCallbacks(assistantLocalId, userLocalId)
      const cfg = getConfig()
      try {
        const model = selectedModel ?? cfg?.defaultModel
        const reasoningSupported = model
          ? (cfg?.reasoningModels ?? []).some((item) => item.toLowerCase() === model.toLowerCase())
          : false
        await sendStream(message, {
          enableWebSearch: streamOptions.enableWebSearch ?? false,
          ...streamOptions,
          model,
          reasoningEffort: reasoningSupported ? (streamOptions.reasoningEffort ?? reasoningEffort) : null,
        })
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          console.error('[ai-chat] send failed', err)
        }
      }
    },
    [showInput, onSend, phase, activeServerId, sendStream, wireStreamCallbacks, reasoningEffort, selectedModel],
  )

  // ── Typewriter segments ──────────────────────────────────────────
  const typewriterSegments: TextSegment[] = useMemo(
    () => [
      { text: `${title} `, speed: 80 },
      { text: titleHighlight, highlight: true, speed: 100 },
      { text: ' 什么？', speed: 80 },
    ],
    [title, titleHighlight]
  )

  return (
    <div
      ref={rootRef}
      className="relative h-full w-full overflow-hidden bg-[#0f0f0f] safe-area-inset-top safe-area-inset-bottom"
      style={{ ['--sidebar-width' as string]: '280px' }}
    >
      <style dangerouslySetInnerHTML={{ __html: animationStyles }} />

      {/* Layer 1: Background */}
      <div className="absolute inset-0">
        <RayBackground arcsUp={arcsUp} />
        <FloatingParticles />
      </div>

      {/* Sidebar toggle — always visible on landing + chat. Sits at the root
          (not inside the chat messages layer) so 首屏 can open 对话历史.
          z-30 keeps it under the sidebar (z-40) and the input strip (z-40),
          but above the landing hero / chat messages (z-0). Hidden when the
          caller passes showInput={false} (e.g. the /dashboard/ai entry page). */}
      {showInput && !showSidebar && (
        <button
          type="button"
          onClick={() => setShowSidebar(true)}
          className="absolute top-4 left-4 z-30 flex items-center justify-center size-9 rounded-xl bg-white/[0.06] border border-white/[0.08] text-[#8a8a8f] hover:text-white hover:bg-white/[0.1] transition-all duration-200 active:scale-95"
          aria-label="打开对话历史"
        >
          <PanelLeft className="size-4" />
        </button>
      )}

      {/* Provider-unconfigured banner — shown only when the backend reports
          `providerConfigured: false` (most often because the .env lacks
          AI_CHAT_PROVIDER_API_KEY). It surfaces above the input so the user
          understands why nothing happens. Width matches the input box (max
          680px centered) so it never bleeds left into the conversation
          sidebar's header (where the new-conversation / close buttons
          live). */}
      {showInput && providerConfigured === false && (
        <div className="absolute left-1/2 top-4 z-30 -translate-x-1/2 w-full max-w-[680px] px-3 sm:px-4">
          <div className="flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-200">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <div>
              <p className="font-medium">后端 AI Provider 未配置</p>
              <p className="mt-0.5 text-amber-200/70">请在 <code className="rounded bg-amber-500/10 px-1">backend/.env</code> 配置 <code className="rounded bg-amber-500/10 px-1">AI_CHAT_PROVIDER_API_KEY</code> 后重启后端服务。</p>
            </div>
          </div>
        </div>
      )}

      {/* Layer 2: Sidebar — z-40 + `pointer-events-none` on the outer
          GSAP-stripped wrapper, and the ConversationSidebar's own
          z-index keeps it on top of the chat layer (z-30). The input
          layer below uses z-40 / pointer-events: none on its outer strip,
          with `pointer-events-auto` only on the centered input box, so
          the sidebar's footer / new-conversation button stay clickable
          even when the input strip sits visually below the sidebar. */}
      {showSidebar && (
        <div ref={sidebarRef} className="pointer-events-none absolute inset-0 z-40">
          <ConversationSidebar
            conversations={conversations}
            activeId={activeConvId}
            onSelect={handleSelectConversation}
            onCreate={handleCreateConversation}
            onRename={handleRenameConversation}
            onDelete={handleDeleteConversation}
            onClose={() => setShowSidebar(false)}
          />
        </div>
      )}

      {/* Layer 3: Landing */}
      <div
        className="absolute inset-0 flex flex-col items-center transition-opacity duration-300"
        style={{
          opacity: isLanding ? 1 : 0,
          pointerEvents: isLanding ? 'auto' : 'none',
        }}
      >
        <div className="absolute top-[60px] sm:top-[70px]">
          <AnnouncementBadge
            text={announcementText}
            href={announcementHref}
          />
        </div>

        <div className="absolute left-1/2 top-[32%] -translate-x-1/2 -translate-y-1/2 flex flex-col items-center justify-center w-full px-6 sm:px-4">
          <div className="text-center mb-4 sm:mb-6">
            <h1 className="text-3xl sm:text-4xl md:text-5xl font-bold text-white tracking-tight mb-3 min-h-[1.2em]">
              <TypewriterText
                segments={typewriterSegments}
                startDelay={800}
              />
            </h1>
            <p
              className="text-sm sm:text-base md:text-lg font-semibold text-[#8a8a8f] bb-anim-fade-up"
              style={{ animationDelay: '3s' }}
            >
              {subtitle}
            </p>
          </div>
        </div>
      </div>

      {/* Layer 4: Chat messages */}
      {(hasMessages || loadingMessages) && (
        <div
          ref={chatScrollRef}
          className={`absolute inset-0 overflow-y-auto overscroll-contain ${
            isChat ? 'bb-chat-enter' : 'opacity-0'
          }`}
          style={{
            paddingLeft: showSidebar ? 'var(--sidebar-width, 280px)' : '0px',
            paddingTop: 'env(safe-area-inset-top, 16px)',
            paddingBottom: 'calc(120px + env(safe-area-inset-bottom, 16px))',
            transition: 'padding-left 0.35s cubic-bezier(0.16, 1, 0.3, 1)',
          }}
        >
          <div className="px-3 sm:px-4 pt-6 pb-4">
            {loadingMessages ? (
              <div className="mx-auto max-w-3xl space-y-4">
                <div className="flex gap-3">
                  <Skeleton className="h-8 w-8 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-4 w-2/3" />
                  </div>
                </div>
                <div className="flex gap-3">
                  <Skeleton className="h-8 w-8 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-1/2" />
                  </div>
                </div>
              </div>
            ) : (
              <ChatMessageList
                messages={messages}
                onRegenerate={handleRegenerateMessage}
                onEdit={handleEditMessage}
                onDelete={handleDeleteMessage}
                streamError={streamError}
                onRetry={
                  messages.length >= 2 && isStreaming === false
                    ? () => {
                        // Retry the most recent assistant message by
                        // re-running regenerate on it. If the assistant
                        // has no serverId yet (e.g. network died before
                        // the first `done`), fall back to regenerating the
                        // last user message instead.
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
                <p className="text-xs text-[#5a5a5f]">正在加载历史会话…</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Layer 5: Input — outer wrapper is `pointer-events-none` so the
          full-width strip doesn't intercept clicks meant for the
          conversation sidebar's bottom region (footer / last list items).
          Only the inner centered 680px input box re-enables
          `pointer-events-auto`. */}
      {showInput && (
        <div
          className="absolute left-0 right-0 w-full px-3 sm:px-4 pointer-events-none"
          style={{
            paddingLeft: showSidebar ? 'var(--sidebar-width, 280px)' : '0px',
            ...(isLanding
              ? { top: '55%', transform: 'translateY(-50%)' }
              : {
                  bottom: '0',
                  paddingBottom: 'env(safe-area-inset-bottom, 16px)',
                }),
            transition:
              'padding-left 0.35s cubic-bezier(0.16, 1, 0.3, 1), top 0.7s cubic-bezier(0.22, 1, 0.36, 1), bottom 0.7s cubic-bezier(0.22, 1, 0.36, 1)',
            zIndex: 40,
          }}
        >
          <div className="relative w-full max-w-[680px] mx-auto pointer-events-auto">
            {/* Stop button */}
            <div
              className="absolute -top-14 left-1/2 -translate-x-1/2"
              style={{ opacity: 0 }}
            >
              <button
                ref={stopBtnRef}
                type="button"
                onClick={handleStopGeneration}
                className="flex items-center gap-2 px-4 py-2 rounded-full bg-white/[0.06] border border-white/[0.08] text-[#8a8a8f] hover:text-white hover:bg-white/[0.1] transition-all duration-200 active:scale-95"
                style={{
                  animation:
                    isStreaming
                      ? 'bb-stop-pulse 1.5s ease-in-out infinite'
                      : 'none',
                }}
                aria-label="停止生成"
              >
                <Square className="size-3 fill-current" />
                <span className="text-xs font-medium">停止生成</span>
              </button>
            </div>

            <ChatInput
              placeholder={isLanding ? placeholder : '继续对话...'}
              onSend={(msg, opts) => handleSend(msg, {
                ...opts,
                enableWebSearch,
                model: selectedModel,
              })}
              compact={!isLanding}
              disabled={isStreaming || activeServerId == null}
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
