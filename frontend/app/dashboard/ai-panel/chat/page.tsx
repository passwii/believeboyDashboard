'use client'

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  Bot,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileText,
  Globe,
  Lightbulb,
  Loader2,
  MessageCirclePlus,
  PanelLeftClose,
  Paperclip,
  PenLine,
  Pin,
  RefreshCw,
  Search,
  SendHorizontal,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  TrendingUp,
  User,
  X,
} from 'lucide-react'

import { AIChatMessageContent } from '@/components/ai-chat-message-content'
import { AIChatSearchSources } from '@/components/ai-chat-search-sources'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { parseResponseError } from '@/lib/error-utils'
import { cn } from '@/lib/utils'
import { useConfirm } from '@/hooks/use-confirm'

type ConversationItem = {
  id: number
  title: string
  created_at: string
  updated_at: string
  pinned_at?: string | null
}

type ChatMessage = {
  id: number | string
  conversation_id: number
  role: 'user' | 'assistant'
  content: string
  search_sources?: SearchSource[]
  is_complete?: boolean
  created_at: string
  streaming?: boolean
  failed?: boolean
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  duration_ms?: number
}

type SearchSource = {
  title?: string
  url?: string
  snippet?: string
  domain?: string
  score?: number | null
}

type StreamEvent =
  | { type: 'start' }
  | { type: 'sources'; sources?: SearchSource[] }
  | { type: 'tool_calls'; tool_calls?: ToolCallInfo[] }
  | { type: 'tool_searching'; tool_name?: string; query?: string }
  | { type: 'tool_done'; tool_name?: string; success?: boolean }
  | { type: 'chunk'; delta?: string }
  | { type: 'usage'; usage?: TokenUsage }
  | {
      type: 'done'
      user_message: ChatMessage
      assistant_message: ChatMessage
      conversation_title?: string
      title_regenerated?: boolean
      token_usage?: TokenUsage
      duration_ms?: number
    }
  | { type: 'error'; message?: string }

type TokenUsage = {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

type ToolCallInfo = {
  id: string
  type: string
  function: {
    name: string
    arguments: string
  }
}

type PromptOption = {
  id: string
  label: string
  description: string
}

type ChatConfigResponse = {
  providerConfigured: boolean
  webSearchConfigured: boolean
  models: string[]
  defaultModel: string
  premiumModels: string[]
  basicModels: string[]
  timeoutSeconds: number
  maxConversationTurns: number
  overviewOptions: PromptOption[]
  detailOptions: PromptOption[]
  message?: string
}

type ChatSettings = {
  model: string
  overviewPromptId: string
  detailPromptId: string
  enableWebSearch: boolean
  maxConversationTurns: number
}

type RegenerateTitleResponse = {
  conversation: ConversationItem
  regenerated: boolean
}

type AttachedFile = {
  fileName: string
  fileType: string
  content: string
  truncated: boolean
  truncatedNote: string | null
}

const CHAT_SETTINGS_STORAGE_KEY = 'believeboy-ai-chat-settings-v4'
const SCROLL_BOTTOM_THRESHOLD = 48

const isDefaultModel = (model: string, defaultModel?: string) =>
  defaultModel ? model.toLowerCase() === defaultModel.toLowerCase() : false


const defaultChatSettings: ChatSettings = {
  model: '',
  overviewPromptId: 'none',
  detailPromptId: 'none',
  enableWebSearch: false,
  maxConversationTurns: 10,
}

function formatMessageTime(isoString: string): string {
  const date = new Date(isoString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return '刚刚'
  if (diffMins < 60) return `${diffMins}分钟前`
  if (diffHours < 24) return `${diffHours}小时前`
  if (diffDays < 7) return `${diffDays}天前`
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

function TypingIndicator() {
  return (
    <div className="flex items-center gap-0.5">
      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-bounce" style={{ animationDelay: '0ms' }} />
      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-bounce" style={{ animationDelay: '150ms' }} />
      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-bounce" style={{ animationDelay: '300ms' }} />
    </div>
  )
}

function SearchProgress({ query }: { query: string }) {
  return (
    <div className="flex items-center gap-2 min-w-24">
      <div className="flex-1 h-1 rounded-full bg-muted-foreground/20 overflow-hidden">
        <div className="h-full w-2/3 bg-blue-500/60 rounded-full animate-pulse" />
      </div>
      <span className="text-xs truncate max-w-20">{query}</span>
    </div>
  )
}

function buildTempMessage(
  id: string,
  conversationId: number,
  role: 'user' | 'assistant',
  content: string,
  options?: Partial<Pick<ChatMessage, 'streaming' | 'failed'>>
): ChatMessage {
  return {
    id,
    conversation_id: conversationId,
    role,
    content,
    created_at: new Date().toISOString(),
    streaming: options?.streaming ?? false,
    failed: options?.failed ?? false,
  }
}

function appendChunkToMessage(messages: ChatMessage[], id: string, delta: string) {
  return messages.map((message) =>
    message.id === id
      ? {
          ...message,
          content: `${message.content}${delta}`,
          streaming: true,
        }
      : message
  )
}

function attachSearchSourcesToMessage(messages: ChatMessage[], id: string, sources: SearchSource[]) {
  return messages.map((message) =>
    message.id === id
      ? {
          ...message,
          search_sources: sources,
        }
      : message
  )
}

function replaceTempMessages(
  messages: ChatMessage[],
  userTempId: string,
  assistantTempId: string,
  userMessage: ChatMessage,
  assistantMessage: ChatMessage
) {
  return messages.map((message) => {
    if (message.id === userTempId) {
      return { ...userMessage, streaming: false, failed: false }
    }
    if (message.id === assistantTempId) {
      return { ...assistantMessage, streaming: false, failed: false }
    }
    return message
  })
}

function upsertConversation(items: ConversationItem[], nextConversation: ConversationItem) {
  return [...items.filter((item) => item.id !== nextConversation.id), nextConversation].sort(
    (left, right) => new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime()
  )
}

function updateConversationTitle(items: ConversationItem[], conversationId: number, newTitle: string) {
  return items.map((item) =>
    item.id === conversationId ? { ...item, title: newTitle } : item
  )
}

async function readNdjsonStream(response: Response, onEvent: (event: StreamEvent) => void) {
  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error('浏览器未返回可读流')
  }

  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) {
      break
    }

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) {
        continue
      }
      onEvent(JSON.parse(trimmed) as StreamEvent)
    }
  }

  const rest = buffer.trim()
  if (rest) {
    onEvent(JSON.parse(rest) as StreamEvent)
  }
}

export default function AIChatPage() {
  const { confirm } = useConfirm()
  const [conversations, setConversations] = useState<ConversationItem[]>([])
  const [activeConversationId, setActiveConversationId] = useState<number | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [prompt, setPrompt] = useState('')
  const [chatConfig, setChatConfig] = useState<ChatConfigResponse | null>(null)
  const [chatSettings, setChatSettings] = useState<ChatSettings>(defaultChatSettings)
  const [loadingConfig, setLoadingConfig] = useState(false)
  const [loadingConversations, setLoadingConversations] = useState(false)
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [refreshingPanel, setRefreshingPanel] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [leftPanelOpen, setLeftPanelOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [busyConversationAction, setBusyConversationAction] = useState<string | null>(null)
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true)
  const [isToolSearching, setIsToolSearching] = useState(false)
  const [searchingQuery, setSearchingQuery] = useState('')
  const [lastTokenUsage, setLastTokenUsage] = useState<TokenUsage | null>(null)
  const [lastDurationMs, setLastDurationMs] = useState<number | null>(null)
  const [attachedFile, setAttachedFile] = useState<AttachedFile | null>(null)
  const [uploadingFile, setUploadingFile] = useState(false)
  const [fileUploadError, setFileUploadError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [pinnedConversationIds, setPinnedConversationIds] = useState<Set<number>>(new Set())
  const [editingConversationId, setEditingConversationId] = useState<number | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const chatScrollRef = useRef<HTMLDivElement | null>(null)
  const messageRequestRef = useRef(0)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const activeRequestControllerRef = useRef<Map<number, AbortController>>(new Map())
  const nextScrollBehaviorRef = useRef<ScrollBehavior | null>(null)

  const activeConversation = useMemo(
    () => conversations.find((item) => item.id === activeConversationId) ?? null,
    [activeConversationId, conversations]
  )

  const filteredConversations = useMemo(() => {
    if (!searchQuery.trim()) return conversations
    return conversations.filter((item) =>
      item.title.toLowerCase().includes(searchQuery.toLowerCase())
    )
  }, [conversations, searchQuery])

  const groupedConversations = useMemo(() => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const yesterday = new Date(today)
    yesterday.setDate(yesterday.getDate() - 1)

    const groups: { label: string; items: ConversationItem[] }[] = [
      { label: '置顶', items: [] },
      { label: '今天', items: [] },
      { label: '昨天', items: [] },
      { label: '更早', items: [] },
    ]

    filteredConversations.forEach((item) => {
      const itemDate = new Date(item.updated_at)
      itemDate.setHours(0, 0, 0, 0)

      if (pinnedConversationIds.has(item.id)) {
        groups[0].items.push(item)
      } else if (itemDate.getTime() === today.getTime()) {
        groups[1].items.push(item)
      } else if (itemDate.getTime() === yesterday.getTime()) {
        groups[2].items.push(item)
      } else {
        groups[3].items.push(item)
      }
    })

    return groups.filter((g) => g.items.length > 0)
  }, [filteredConversations, pinnedConversationIds])

  const regenerationTarget = useMemo(() => {
    if (messages.length < 2) {
      return null
    }
    const lastAssistant = messages[messages.length - 1]
    const lastUser = messages[messages.length - 2]
    if (lastAssistant.role !== 'assistant' || lastUser.role !== 'user') {
      return null
    }
    if (typeof lastAssistant.id !== 'number' || lastAssistant.streaming || lastAssistant.failed) {
      return null
    }
    return {
      assistant: lastAssistant,
    }
  }, [messages])

  const canRegenerate = Boolean(activeConversationId && regenerationTarget && !submitting)

  const isNearBottom = useCallback((element: HTMLDivElement) => {
    return element.scrollHeight - element.scrollTop - element.clientHeight <= SCROLL_BOTTOM_THRESHOLD
  }, [])

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const element = chatScrollRef.current
    if (!element) {
      return
    }
    element.scrollTo({ top: element.scrollHeight, behavior })
    setAutoScrollEnabled(true)
  }, [])

  const loadConfig = useCallback(async () => {
    setLoadingConfig(true)
    setError(null)
    try {
      const response = await fetch('/api/ai-chat/config', {
        method: 'GET',
        cache: 'no-store',
      })
      const payload = (await response.json()) as ChatConfigResponse
      if (!response.ok) {
        throw new Error(payload.message || `加载配置失败 (${response.status})`)
      }

      setChatConfig(payload)
      setChatSettings((prev) => {
        const userModels = payload.models.filter((m) => !isDefaultModel(m, payload.defaultModel))
        const defaultModel = payload.defaultModel || (userModels[0] && userModels[0].trim()) || payload.models[0] || ''
        return {
          ...prev,
          model: (userModels[0] && userModels.includes(prev.model)) ? prev.model : defaultModel,
          overviewPromptId:
          payload.overviewOptions.some((item) => item.id === prev.overviewPromptId)
            ? prev.overviewPromptId
            : defaultChatSettings.overviewPromptId,
        detailPromptId:
          payload.detailOptions.some((item) => item.id === prev.detailPromptId)
            ? prev.detailPromptId
            : defaultChatSettings.detailPromptId,
        maxConversationTurns: payload.maxConversationTurns || 10,
        }
      })
      if (payload.message) {
        setError(payload.message)
      }
      if (!payload.webSearchConfigured) {
        setChatSettings((prev) => ({ ...prev, enableWebSearch: false }))
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载配置失败')
    } finally {
      setLoadingConfig(false)
    }
  }, [])

  const loadConversations = useCallback(async (preferredConversationId?: number | null) => {
    setLoadingConversations(true)
    setError(null)
    try {
      const response = await fetch('/api/ai-chat/conversations', {
        method: 'GET',
        cache: 'no-store',
      })
      if (!response.ok) {
        throw new Error(await parseResponseError(response, '加载会话失败'))
      }

      const payload = (await response.json()) as ConversationItem[]
      setConversations(payload)
      setActiveConversationId((currentId) => {
        const desiredId = preferredConversationId ?? currentId
        if (desiredId && payload.some((item) => item.id === desiredId)) {
          return desiredId
        }
        return payload[0]?.id ?? null
      })
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载会话失败')
    } finally {
      setLoadingConversations(false)
    }
  }, [])

  const loadMessages = useCallback(async (conversationId: number) => {
    const requestId = messageRequestRef.current + 1
    messageRequestRef.current = requestId
    setLoadingMessages(true)
    setError(null)
    try {
      const response = await fetch(`/api/ai-chat/conversations/${conversationId}/messages`, {
        method: 'GET',
        cache: 'no-store',
      })
      if (!response.ok) {
        throw new Error(await parseResponseError(response, '加载消息失败'))
      }
      const payload = (await response.json()) as ChatMessage[]
      if (messageRequestRef.current !== requestId) {
        return
      }
      const processedPayload = payload.map((msg) => {
        if (msg.role === 'assistant' && msg.is_complete === false) {
          return { ...msg, streaming: true }
        }
        return msg
      })
      nextScrollBehaviorRef.current = 'auto'
      setMessages(processedPayload)
      setAutoScrollEnabled(true)
    } catch (loadError) {
      if (messageRequestRef.current !== requestId) {
        return
      }
      setError(loadError instanceof Error ? loadError.message : '加载消息失败')
    } finally {
      if (messageRequestRef.current === requestId) {
        setLoadingMessages(false)
      }
    }
  }, [])

  const createConversation = useCallback(async () => {
    setError(null)
    try {
      const response = await fetch('/api/ai-chat/conversations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: `会话 ${new Date().toLocaleString()}` }),
      })
      if (!response.ok) {
        throw new Error(await parseResponseError(response, '创建会话失败'))
      }
      const payload = (await response.json()) as ConversationItem
      nextScrollBehaviorRef.current = 'auto'
      setConversations((prev) => upsertConversation(prev, payload))
      setActiveConversationId(payload.id)
      setMessages([])
      setAutoScrollEnabled(true)
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : '创建会话失败')
    }
  }, [])

  const handleRefreshPanel = useCallback(async () => {
    setRefreshingPanel(true)
    try {
      await Promise.all([loadConfig(), loadConversations(activeConversationId)])
      if (activeConversationId) {
        await loadMessages(activeConversationId)
      }
    } finally {
      setRefreshingPanel(false)
    }
  }, [activeConversationId, loadConfig, loadConversations, loadMessages])

  const handleDeleteConversation = useCallback(
    async (conversationId: number) => {
      if (submitting) {
        return
      }
      const confirmed = await confirm({ title: '删除后该会话及消息不可恢复，确认继续吗？', variant: 'destructive' })
      if (!confirmed) {
        return
      }

      setBusyConversationAction(`delete-${conversationId}`)
      setError(null)
      try {
        const response = await fetch(`/api/ai-chat/conversations/${conversationId}`, {
          method: 'DELETE',
        })
        if (!response.ok) {
          throw new Error(await parseResponseError(response, '删除会话失败'))
        }

        const remainingConversations = conversations.filter((item) => item.id !== conversationId)
        setConversations(remainingConversations)
        if (activeConversationId === conversationId) {
          const fallbackConversationId = remainingConversations[0]?.id ?? null
          setActiveConversationId(fallbackConversationId)
          if (!fallbackConversationId) {
            setMessages([])
          }
        }
      } catch (deleteError) {
        setError(deleteError instanceof Error ? deleteError.message : '删除会话失败')
      } finally {
        setBusyConversationAction(null)
      }
    },
    [activeConversationId, conversations, submitting]
  )

  const handleRegenerateTitle = useCallback(async (conversationId: number) => {
    setBusyConversationAction(`title-${conversationId}`)
    setError(null)
    try {
      const response = await fetch(`/api/ai-chat/conversations/${conversationId}`, {
        method: 'POST',
      })
      if (!response.ok) {
        throw new Error(await parseResponseError(response, '重生成标题失败'))
      }

      const payload = (await response.json()) as RegenerateTitleResponse
      setConversations((prev) => updateConversationTitle(prev, conversationId, payload.conversation.title))
      if (!payload.regenerated) {
        setError('当前会话内容不足，暂时无法重生成标题')
      }
    } catch (regenerateError) {
      setError(regenerateError instanceof Error ? regenerateError.message : '重生成标题失败')
    } finally {
      setBusyConversationAction(null)
    }
  }, [])

  const handleFileChange = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    setFileUploadError(null)
    setUploadingFile(true)

    try {
      const formData = new FormData()
      formData.append('file', file)

      const response = await fetch('/api/file-upload', {
        method: 'POST',
        headers: {
          'X-File-Name': file.name,
        },
        body: formData,
      })

      if (!response.ok) {
        const err = await response.json().catch(() => ({ message: '上传失败' }))
        throw new Error(err.message || `上传失败 (${response.status})`)
      }

      const payload = await response.json() as { file_name: string; file_type: string; content: string; truncated: boolean; truncated_note: string | null }
      setAttachedFile({
        fileName: payload.file_name,
        fileType: payload.file_type,
        content: payload.content,
        truncated: payload.truncated,
        truncatedNote: payload.truncated_note,
      })
    } catch (err) {
      setFileUploadError(err instanceof Error ? err.message : '文件上传失败')
    } finally {
      setUploadingFile(false)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }, [])

  const handleRemoveAttachedFile = useCallback(() => {
    setAttachedFile(null)
    setFileUploadError(null)
  }, [])

  const runMessageStream = useCallback(
    async (options: { content?: string; regenerate?: boolean; targetMessageId?: number | string }) => {
      if (!activeConversationId || submitting) {
        return
      }
      if (!chatConfig?.providerConfigured) {
        setError('后端 AI Provider 未配置，请先检查后端环境变量')
        return
      }
      if (!chatSettings.model) {
        setError('请选择模型')
        return
      }

      const regenerate = Boolean(options.regenerate)
      const content = options.content?.trim() || ''
      if (!regenerate && !content) {
        return
      }

      let currentRegenTarget = null
      if (regenerate) {
        if (options.targetMessageId) {
          const targetIndex = messages.findIndex((m) => m.id === options.targetMessageId)
          if (targetIndex > 0 && messages[targetIndex - 1].role === 'user') {
            currentRegenTarget = { assistant: messages[targetIndex], userIndex: targetIndex - 1 }
          }
        }
        if (!currentRegenTarget && !regenerationTarget) {
          setError('当前没有可重新生成的回答')
          return
        }
        if (!currentRegenTarget) {
          currentRegenTarget = regenerationTarget
        }
      }

      const maxTurns = chatSettings.maxConversationTurns || chatConfig?.maxConversationTurns || 10
      if (!regenerate && messages.length >= maxTurns * 2) {
        setError(`对话轮次已达上限 (${maxTurns}次)，请新建会话继续对话`)
        return
      }

      const conversationId = activeConversationId
      const userTempId = regenerate ? null : `user-${Date.now()}`
      const assistantTempId = `assistant-${Date.now()}`
      const controller = new AbortController()
      activeRequestControllerRef.current.set(conversationId, controller)

      setSubmitting(true)
      setError(null)
      setAutoScrollEnabled(true)

      if (!regenerate) {
        setPrompt('')
        setMessages((prev) => [
          ...prev,
          buildTempMessage(userTempId as string, conversationId, 'user', content),
          buildTempMessage(assistantTempId, conversationId, 'assistant', '', { streaming: true }),
        ])
      } else {
        setMessages((prev) => [...prev, buildTempMessage(assistantTempId, conversationId, 'assistant', '', { streaming: true })])
      }

      try {
        const response = await fetch(`/api/ai-chat/conversations/${conversationId}/messages/stream`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            content,
            regenerate,
            target_message_id: regenerate && options.targetMessageId ? Number(options.targetMessageId) : null,
            model: chatSettings.model,
            overviewPromptId: chatSettings.overviewPromptId,
            detailPromptId: chatSettings.detailPromptId,
            enableWebSearch: chatSettings.enableWebSearch,
            attachedFileContent: attachedFile?.content || null,
            attachedFileName: attachedFile?.fileName || null,
          }),
          signal: controller.signal,
        })
        if (!response.ok) {
          throw new Error(await parseResponseError(response, regenerate ? '重新生成失败' : '发送失败'))
        }

        let completed = false
        await readNdjsonStream(response, (streamEvent) => {
          if (streamEvent.type === 'start') {
            return
          }

          if (streamEvent.type === 'tool_calls') {
            return
          }

          if (streamEvent.type === 'tool_searching') {
            setIsToolSearching(true)
            setSearchingQuery(streamEvent.query || '')
            return
          }

          if (streamEvent.type === 'tool_done') {
            setIsToolSearching(false)
            setSearchingQuery('')
            return
          }

          if (streamEvent.type === 'sources') {
            setMessages((prev) => attachSearchSourcesToMessage(prev, assistantTempId, streamEvent.sources || []))
            return
          }

          if (streamEvent.type === 'usage') {
            setLastTokenUsage(streamEvent.usage || null)
            return
          }

          if (streamEvent.type === 'chunk') {
            const delta = streamEvent.delta || ''
            if (!delta) {
              return
            }
            setMessages((prev) => appendChunkToMessage(prev, assistantTempId, delta))
            return
          }

          if (streamEvent.type === 'error') {
            completed = true
            setIsToolSearching(false)
            const message = streamEvent.message || (regenerate ? '重新生成失败' : '发送失败')
            setMessages((prev) =>
              prev.map((item) =>
                item.id === assistantTempId
                  ? { ...item, content: message, streaming: false, failed: true }
                  : item
              )
            )
            setError(message)
            return
          }

          completed = true
          setIsToolSearching(false)
          if (streamEvent.duration_ms) {
            setLastDurationMs(streamEvent.duration_ms)
          }
          if (streamEvent.token_usage) {
            setLastTokenUsage(streamEvent.token_usage)
          }

          completed = true
          setMessages((prev) => {
            if (!regenerate) {
              return replaceTempMessages(prev, userTempId as string, assistantTempId, streamEvent.user_message, streamEvent.assistant_message)
            }

            return prev
              .filter((item) => item.id !== assistantTempId && item.id !== currentRegenTarget?.assistant.id)
              .concat({
                ...streamEvent.assistant_message,
                streaming: false,
                failed: false,
                prompt_tokens: streamEvent.token_usage?.prompt_tokens,
                completion_tokens: streamEvent.token_usage?.completion_tokens,
                total_tokens: streamEvent.token_usage?.total_tokens,
                duration_ms: streamEvent.duration_ms,
              })
          })
          setConversations((prev) =>
            upsertConversation(prev, {
              ...(prev.find((item) => item.id === conversationId) ?? {
                id: conversationId,
                title: '新对话',
                created_at: streamEvent.user_message.created_at,
                updated_at: streamEvent.assistant_message.created_at,
              }),
              ...(streamEvent.title_regenerated && streamEvent.conversation_title
                ? { title: streamEvent.conversation_title }
                : {}),
              updated_at: streamEvent.assistant_message.created_at,
            })
          )
          setAttachedFile(null)
          setFileUploadError(null)
        })

        if (!completed) {
          throw new Error('响应流提前结束')
        }
      } catch (sendError) {
        const aborted = sendError instanceof DOMException && sendError.name === 'AbortError'
        if (!regenerate && aborted) {
          setPrompt(content)
        }
        setMessages((prev) =>
          prev
            .map((item) =>
              item.id === assistantTempId
                ? {
                    ...item,
                    content: aborted ? item.content || '已停止生成' : sendError instanceof Error ? sendError.message : regenerate ? '重新生成失败' : '发送失败',
                    streaming: false,
                    failed: aborted ? false : true,
                  }
                : item
            )
            .filter((item) => !(regenerate && aborted && item.id === assistantTempId && !item.content.trim()))
        )
        if (!aborted) {
          setError(sendError instanceof Error ? sendError.message : regenerate ? '重新生成失败' : '发送失败')
        }
      } finally {
        activeRequestControllerRef.current.delete(conversationId)
        setSubmitting(false)
      }
    },
    [activeConversationId, chatConfig?.providerConfigured, chatSettings, chatConfig, messages, regenerationTarget, submitting, attachedFile]
  )

  const handleTextareaChange = useCallback((event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setPrompt(event.target.value)
    const textarea = event.target
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 150)}px`
  }, [])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        if (prompt.trim() && activeConversationId && !submitting) {
          void runMessageStream({ content: prompt })
        }
      }
    },
    [prompt, activeConversationId, submitting, runMessageStream]
  )

  const handleSend = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      await runMessageStream({ content: prompt })
    },
    [prompt, runMessageStream]
  )

  const handleStopGenerating = useCallback(() => {
    if (activeConversationId) {
      activeRequestControllerRef.current?.get(activeConversationId)?.abort()
    }
  }, [activeConversationId])

  const handleRegenerateReply = useCallback(async () => {
    await runMessageStream({ regenerate: true })
  }, [runMessageStream])

  const handleRegenerateMessage = useCallback(
    async (messageId: number | string) => {
      await runMessageStream({ regenerate: true, targetMessageId: messageId })
    },
    [runMessageStream]
  )

  const handleTogglePin = useCallback((conversationId: number) => {
    setPinnedConversationIds((prev) => {
      const next = new Set(prev)
      if (next.has(conversationId)) {
        next.delete(conversationId)
      } else {
        next.add(conversationId)
      }
      return next
    })
  }, [])

  const handleStartRename = useCallback((conversationId: number, currentTitle: string) => {
    setEditingConversationId(conversationId)
    setEditingTitle(currentTitle)
  }, [])

  const handleRenameConversation = useCallback(async (conversationId: number, newTitle: string) => {
    if (!newTitle.trim()) {
      setEditingConversationId(null)
      return
    }
    setBusyConversationAction(`rename-${conversationId}`)
    try {
      const response = await fetch(`/api/ai-chat/conversations/${conversationId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle.trim() }),
      })
      if (!response.ok) {
        throw new Error('重命名失败')
      }
      const payload = (await response.json()) as ConversationItem
      setConversations((prev) => upsertConversation(prev, payload))
    } catch (err) {
      setError(err instanceof Error ? err.message : '重命名失败')
    } finally {
      setBusyConversationAction(null)
      setEditingConversationId(null)
    }
  }, [])

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem('believeboy-ai-chat-pinned-v1')
      if (!raw) return
      const parsed = JSON.parse(raw) as number[]
      setPinnedConversationIds(new Set(parsed))
    } catch {
      // Ignore
    }
  }, [])

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(CHAT_SETTINGS_STORAGE_KEY)
      if (!raw) {
        return
      }
      const parsed = JSON.parse(raw) as Partial<ChatSettings>
      setChatSettings((prev) => ({
        ...prev,
        ...parsed,
      }))
    } catch {
      // Ignore invalid localStorage payload.
    }
  }, [])

  useEffect(() => {
    window.localStorage.setItem(
      'believeboy-ai-chat-pinned-v1',
      JSON.stringify(Array.from(pinnedConversationIds))
    )
  }, [pinnedConversationIds])

  useEffect(() => {
    window.localStorage.setItem(CHAT_SETTINGS_STORAGE_KEY, JSON.stringify(chatSettings))
  }, [chatSettings])

  useEffect(() => {
    if (!prompt && textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [prompt])

  useEffect(() => {
    return () => {
      const controllers = activeRequestControllerRef.current
      controllers.forEach((controller) => controller.abort())
      controllers.clear()
    }
  }, [])

  useEffect(() => {
    void loadConfig()
    void loadConversations()
  }, [loadConfig, loadConversations])

  useEffect(() => {
    if (!activeConversationId) {
      setMessages([])
      setLoadingMessages(false)
      setSubmitting(false)
      return
    }
    const prevConversationId = activeRequestControllerRef.current.size > 0
      ? Array.from(activeRequestControllerRef.current.keys()).find((id) => id !== activeConversationId)
      : undefined
    if (prevConversationId) {
      activeRequestControllerRef.current.get(prevConversationId)?.abort()
      activeRequestControllerRef.current.delete(prevConversationId)
    }
    setSubmitting(false)
    void loadMessages(activeConversationId)
  }, [activeConversationId, loadMessages])

  useEffect(() => {
    if (!autoScrollEnabled) {
      return
    }
    const frame = window.requestAnimationFrame(() => {
      const behavior = nextScrollBehaviorRef.current ?? 'auto'
      nextScrollBehaviorRef.current = null
      scrollToBottom(behavior)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [autoScrollEnabled, messages, scrollToBottom])

  return (
    <div className="h-full min-h-0 overflow-hidden bg-background">
      <div className={cn('grid h-full min-h-0', leftPanelOpen ? 'grid-cols-[272px_minmax(0,1fr)]' : 'grid-cols-[0px_minmax(0,1fr)]')}>
        <aside className={cn(
          'min-h-0 min-w-0 border-r border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-950 overflow-hidden transition-all duration-300',
          leftPanelOpen ? 'w-[272px]' : 'w-0 border-0'
        )}>
          <div className="flex h-full min-h-0 flex-col overflow-hidden">
              <div className="flex items-center justify-between min-w-0 border-b border-zinc-200 dark:border-zinc-800 px-3 py-3">
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 rounded-lg text-zinc-500"
                  onClick={() => setLeftPanelOpen((prev) => !prev)}
                  title="折叠会话列表"
                >
                  {leftPanelOpen ? <PanelLeftClose className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </Button>
              </div>
              <Button
                type="button"
                size="sm"
                className={cn(
                  'rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 hover:bg-zinc-800 dark:hover:bg-zinc-200',
                  leftPanelOpen ? 'px-3' : 'h-8 w-8 p-0'
                )}
                onClick={() => void createConversation()}
                title="新建会话"
              >
                <MessageCirclePlus className="h-4 w-4" />
                {leftPanelOpen ? <span className="ml-1.5">新建</span> : null}
              </Button>
            </div>

            {leftPanelOpen ? (
              <div className="min-h-0 flex-1 overflow-hidden">
                <div className="px-2 py-2 overflow-hidden">
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                    <Input
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="搜索会话..."
                      className="h-8 pl-8 text-xs bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-700"
                    />
                  </div>
                </div>
                <ScrollArea className="h-[calc(100%-56px)]">
                  <div className="space-y-1.5 px-2 py-2">

                    {loadingConversations ? (
                      <div className="flex items-center gap-2 px-2 py-2 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>加载中</span>
                      </div>
                    ) : null}
                    {groupedConversations.length > 0 ? (
                      groupedConversations.map((group) => (
                        <div key={group.label}>
                          <p className="px-2 py-1 text-xs font-medium text-muted-foreground">{group.label}</p>
                          {group.items.map((item) => {
                            const titleActionBusy = busyConversationAction === `title-${item.id}`
                            const deleteActionBusy = busyConversationAction === `delete-${item.id}`
                            const renameActionBusy = busyConversationAction === `rename-${item.id}`
                            const active = activeConversationId === item.id
                            const isPinned = pinnedConversationIds.has(item.id)
                            const isEditing = editingConversationId === item.id

                            return (
                              <div
                                key={item.id}
                                className={cn(
                                  'group rounded-md px-1 py-1 transition-all cursor-pointer',
                                  active
                                    ? 'bg-zinc-200/70 dark:bg-zinc-800/70'
                                    : 'hover:bg-zinc-100 dark:hover:bg-zinc-800/50'
                                )}
                              >
                                <div className="flex items-center gap-1 overflow-hidden">
                                  {isEditing ? (
                                    <Input
                                      value={editingTitle}
                                      onChange={(e) => setEditingTitle(e.target.value)}
                                      onBlur={() => void handleRenameConversation(item.id, editingTitle)}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                          void handleRenameConversation(item.id, editingTitle)
                                        } else if (e.key === 'Escape') {
                                          setEditingConversationId(null)
                                        }
                                      }}
                                      className="h-5 min-w-0 flex-1 px-1 text-xs"
                                      autoFocus
                                    />
                                  ) : (
                                    <button type="button" onClick={() => setActiveConversationId(item.id)} className="min-w-0 flex-1 text-left">
                                      <p className="truncate text-[0.75rem] font-medium text-zinc-700 dark:text-zinc-300">{item.title}</p>
                                    </button>
                                  )}
                                  <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon"
                                      className={cn(
                                        'h-5 w-5 shrink-0 rounded-md text-muted-foreground',
                                        isPinned ? 'text-primary' : 'text-muted-foreground'
                                      )}
                                      disabled={titleActionBusy || deleteActionBusy || renameActionBusy || submitting}
                                      onClick={() => handleTogglePin(item.id)}
                                      title={isPinned ? '取消置顶' : '置顶'}
                                    >
                                      <Pin className={cn('h-3 w-3', isPinned && 'fill-current')} />
                                    </Button>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon"
                                      className="h-5 w-5 shrink-0 rounded-md text-muted-foreground"
                                      disabled={titleActionBusy || deleteActionBusy || renameActionBusy}
                                      onClick={() => void handleRegenerateTitle(item.id)}
                                      title="重新生成标题"
                                    >
                                      {titleActionBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                                    </Button>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon"
                                      className="h-5 w-5 shrink-0 rounded-md text-muted-foreground hover:text-red-500"
                                      disabled={titleActionBusy || deleteActionBusy || renameActionBusy || submitting}
                                      onClick={() => void handleDeleteConversation(item.id)}
                                      title="删除会话"
                                    >
                                      {deleteActionBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                                    </Button>
                                  </div>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      ))
                    ) : null}
                    {!loadingConversations && filteredConversations.length === 0 ? (
                      <p className="px-2 py-2 text-sm text-muted-foreground">
                        {searchQuery ? '未找到匹配的会话' : '暂无会话，请先新建。'}
                      </p>
                    ) : null}
                  </div>
                </ScrollArea>
              </div>
            ) : (
              <div className="flex flex-1 items-start justify-center pt-3">
                <div className="writing-mode-vertical text-xs tracking-[0.2em] text-muted-foreground [writing-mode:vertical-rl]">
                  AI CHAT
                </div>
              </div>
            )}
          </div>
        </aside>

        <section className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_auto] bg-background">
          <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background">
            <header className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-3">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  {!leftPanelOpen && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-8 gap-1.5 rounded-lg px-2 text-zinc-600 dark:text-zinc-400"
                      onClick={() => void createConversation()}
                      title="新建会话"
                    >
                      <MessageCirclePlus className="h-4 w-4" />
                      <span className="text-sm">新建</span>
                    </Button>
                  )}
                  <Bot className="h-6 w-6 text-zinc-500 dark:text-zinc-400" />
                  <h1 className="truncate text-base font-medium text-zinc-900 dark:text-zinc-100">
                    {activeConversation?.title || '新对话'}
                  </h1>
                  {submitting && (
                    <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                      <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {!leftPanelOpen && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 rounded-full text-muted-foreground"
                      onClick={() => setLeftPanelOpen((prev) => !prev)}
                      title="展开会话列表"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  )}
                  {lastTokenUsage && !submitting && (
                    <div className="hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface-panel/80 border border-surface-outline/30 text-xs text-muted-foreground/80">
                      <span>速度:</span>
                      <span className="font-medium text-foreground/90">
                        {(lastTokenUsage.total_tokens / ((lastDurationMs || 1) / 1000)).toFixed(1)}
                      </span>
                      <span>t/s</span>
                    </div>
                  )}
                  <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full text-muted-foreground" onClick={() => void handleRefreshPanel()} disabled={refreshingPanel} title="刷新">
                    {refreshingPanel ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 rounded-full text-muted-foreground hover:text-red-500"
                    disabled={!activeConversationId || submitting || busyConversationAction === `delete-${activeConversationId}`}
                    onClick={() => activeConversationId && void handleDeleteConversation(activeConversationId)}
                    title="删除会话"
                  >
                    {busyConversationAction === `delete-${activeConversationId}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  </Button>
                  <Button
                    variant={settingsOpen ? 'default' : 'ghost'}
                    size="icon"
                    className={cn('h-8 w-8 rounded-full', settingsOpen ? 'bg-primary text-primary-foreground' : 'text-muted-foreground')}
                    onClick={() => setSettingsOpen((prev) => !prev)}
                    title="设置"
                  >
                    <Settings2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </header>

            <div className="min-h-0 flex-1 overflow-hidden">
              <div ref={chatScrollRef} onScroll={(event) => setAutoScrollEnabled(isNearBottom(event.currentTarget))} className="h-full overflow-y-auto bg-white dark:bg-zinc-900 px-4 py-4">
                  <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-end space-y-6">
                  {messages.map((message, msgIndex) => {
                    const isLastAssistantMessage = message.role === 'assistant' && msgIndex === messages.map((m, i) => m.role === 'assistant' ? i : -1).filter(i => i !== -1).at(-1);
                    return (
                    <div key={message.id} className={cn('flex animate-enter', message.role === 'user' ? 'justify-end' : 'justify-start')}>
                      <div
                        className={cn(
                          'group relative max-w-[85%] flex gap-2',
                          message.role === 'user' && 'flex-row-reverse',
                          message.failed && 'animate-shake'
                        )}
                      >
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700">
                          {message.role === 'assistant' ? (
                            <Bot className="h-4 w-4 text-muted-foreground/70" />
                          ) : (
                            <User className="h-4 w-4 text-zinc-200 dark:text-zinc-800" />
                          )}
                        </div>
                        <div className="flex flex-col gap-1">
                          <div
                            className={cn(
                              'relative w-full px-4 py-3 shadow-sm',
                              message.role === 'assistant'
                                ? 'bg-transparent'
                                : 'bg-zinc-100 dark:bg-zinc-800 rounded-2xl rounded-tr-md',
                              message.failed ? 'bg-red-50/80 border-red-200/60' : ''
                            )}
                          >
                            {message.role === 'assistant' ? (
                              <>
                                {message.search_sources?.length ? (
                                  <AIChatSearchSources sources={message.search_sources} className="mt-0 mb-2" />
                                ) : null}
                                {message.content ? (
                                  <AIChatMessageContent content={message.content} className="[&_p]:text-[15px] [&_p]:leading-7" />
                                ) : message.search_sources?.length ? (
                                  <div className="flex items-center gap-2 text-sm text-muted-foreground/80">
                                    <TypingIndicator />
                                    <span>AI 正在基于搜索结果生成回答...</span>
                                  </div>
                                ) : (
                                  <div className="flex items-center gap-2 text-sm text-muted-foreground/80">
                                    <TypingIndicator />
                                    <span>模型正在思考中...</span>
                                  </div>
                                )}
                                {message.streaming && (
                                  <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground/60">
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                    <span>持续生成中</span>
                                  </div>
                                )}
                                {isToolSearching && message.streaming ? (
                                  <div className="mt-2 flex items-center gap-2 text-xs text-blue-500/80 dark:text-blue-400/80">
                                    <Globe className="h-3 w-3 animate-pulse" />
                                    <SearchProgress query={searchingQuery} />
                                  </div>
                                ) : null}
                              </>
                            ) : (
                              <p className="whitespace-pre-wrap break-words text-[15px] leading-7 text-zinc-800 dark:text-zinc-200">{message.content}</p>
                            )}
                          </div>
                          <div className={cn(
                            'flex items-center justify-between gap-1.5 text-[0.65rem] text-muted-foreground/50',
                            message.role === 'user' && 'flex-row-reverse'
                          )}>
                            <div className={cn('flex items-center gap-1.5', message.role === 'user' && 'flex-row-reverse')}>
                              <span>{formatMessageTime(message.created_at)}</span>
                              {message.role === 'assistant' && !message.streaming && message.content && (
                                <>
                                  <button
                                    onClick={() => void navigator.clipboard.writeText(message.content)}
                                    className="opacity-0 group-hover:opacity-100 transition-opacity hover:text-foreground/70"
                                    title="复制"
                                  >
                                    <Copy className="h-3 w-3" />
                                  </button>
                                  <button
                                    onClick={() => void handleRegenerateMessage(message.id)}
                                    className="opacity-0 group-hover:opacity-100 transition-opacity hover:text-foreground/70"
                                    title="重新生成"
                                  >
                                    <RefreshCw className="h-3 w-3" />
                                  </button>
                                </>
                              )}
                            </div>
                            {isLastAssistantMessage && message.total_tokens && message.duration_ms && (
                              <span className="text-muted-foreground/40">
                                {message.total_tokens >= 1000
                                  ? `${(message.total_tokens / 1000).toFixed(1)}K`
                                  : message.total_tokens} tokens · {(message.total_tokens / (message.duration_ms / 1000)).toFixed(1)} t/s
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                    );
                  })}

                  {!loadingMessages && messages.length === 0 ? (
                    <div className="mx-auto flex max-w-2xl flex-col items-center py-16 text-center">
                      <div className="mb-6">
                        <Bot className="h-12 w-12 text-zinc-400 dark:text-zinc-600" />
                      </div>
                      
                      <h2 className="text-2xl font-normal tracking-tight text-zinc-900 dark:text-zinc-100">
                        有什么可以帮你的？
                      </h2>
                      <p className="mt-3 text-sm leading-6 text-zinc-500 dark:text-zinc-400 max-w-md">
                        输入你的问题，AI 会尽力为你解答
                      </p>
                      
                      <div className="mt-8 flex flex-wrap justify-center gap-2">
                        {[
                          { icon: TrendingUp, text: '分析数据趋势' },
                          { icon: PenLine, text: '帮我写作' },
                          { icon: Lightbulb, text: '获取建议' },
                          { icon: Search, text: '搜索信息' },
                        ].map((item) => (
                          <button
                            key={item.text}
                            onClick={() => setPrompt(item.text)}
                            className="flex items-center gap-2 rounded-full border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50 px-4 py-2 text-sm text-zinc-600 dark:text-zinc-400 transition-colors hover:border-zinc-300 dark:hover:border-zinc-600 hover:text-zinc-900 dark:hover:text-zinc-200"
                          >
                            <item.icon className="h-4 w-4" />
                            <span>{item.text}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>

              {!autoScrollEnabled && messages.length > 0 ? (
                <div className="pointer-events-none absolute bottom-28 right-[max(1.5rem,3vw)] z-30">
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon"
                    className="pointer-events-auto h-11 w-11 rounded-full shadow-[0_12px_32px_rgba(15,23,42,0.14)] dark:shadow-[0_12px_32px_rgba(0,0,0,0.5)]"
                    onClick={() => scrollToBottom('smooth')}
                    title="回到底部并恢复跟随"
                  >
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                </div>
              ) : null}
            </div>

            <div className="relative z-20">
              <div className="bg-transparent px-4 py-4">
                {attachedFile && (
                  <div className="mx-auto max-w-3xl mb-3">
                    <div className="flex items-center gap-3 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50 px-4 py-3">
                      <FileText className="h-5 w-5 text-zinc-500" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-foreground text-sm">{attachedFile.fileName}</p>
                        <p className="text-xs text-zinc-500">{attachedFile.fileType}</p>
                      </div>
                      <button
                        type="button"
                        onClick={handleRemoveAttachedFile}
                        className="shrink-0 rounded-full p-1.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
                        title="移除附件"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                )}
                
                <form onSubmit={handleSend} className="mx-auto">
                  <div className="relative w-full rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-sm transition-all focus-within:border-zinc-300 dark:focus-within:border-zinc-600">
                    <div className="flex items-center gap-2 px-3 py-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className={cn(
                          'h-8 w-8 shrink-0 rounded-lg',
                          attachedFile ? 'text-zinc-600 dark:text-zinc-400 bg-zinc-100 dark:bg-zinc-800' : 'text-zinc-400'
                        )}
                        disabled={!activeConversationId || submitting || uploadingFile}
                        onClick={() => fileInputRef.current?.click()}
                        title="附加文件"
                      >
                        {uploadingFile ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
                      </Button>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept=".csv,.xlsx,.xls,.jpg,.jpeg,.png,.pdf,.txt"
                        className="hidden"
                        onChange={handleFileChange}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className={cn(
                          'h-8 w-8 shrink-0 rounded-lg transition-all',
                          chatSettings.enableWebSearch
                            ? 'bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900'
                            : 'text-zinc-400'
                        )}
                        disabled={!activeConversationId || submitting || !chatConfig?.webSearchConfigured}
                        onClick={() =>
                          setChatSettings((prev) => ({
                            ...prev,
                            enableWebSearch: !prev.enableWebSearch,
                          }))
                        }
                        title={
                          chatConfig?.webSearchConfigured
                            ? chatSettings.enableWebSearch
                              ? '已开启联网搜索'
                              : '开启联网搜索'
                            : '联网搜索未配置'
                        }
                      >
                        <Globe className="h-4 w-4" />
                      </Button>
                      <div className="h-4 w-px bg-surface-outline/30 mx-1" />
                      <textarea
                        ref={textareaRef}
                        value={prompt}
                        onChange={handleTextareaChange}
                        onKeyDown={handleKeyDown}
                        placeholder="输入消息..."
                        disabled={!activeConversationId || submitting}
                        rows={1}
                        className="flex-1 border-0 bg-transparent py-1.5 px-1 shadow-none focus-visible:ring-0 resize-none min-h-[24px] max-h-[150px] text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400"
                      />
                      <div className="flex items-center gap-1">
                        {canRegenerate && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 shrink-0 rounded-lg text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                            onClick={() => void handleRegenerateReply()}
                            title="重新生成"
                          >
                            <RefreshCw className="h-4 w-4" />
                          </Button>
                        )}
                        {submitting && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 shrink-0 rounded-lg text-red-500 hover:text-red-600"
                            onClick={handleStopGenerating}
                            title="停止生成"
                          >
                            <Square className="h-4 w-4 fill-current" />
                          </Button>
                        )}
                        <Button
                          type="submit"
                          size="icon"
                          className={cn(
                            'h-8 w-8 shrink-0 rounded-lg transition-all',
                            prompt.trim() && activeConversationId && !submitting
                              ? 'bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 hover:bg-zinc-800 dark:hover:bg-zinc-200'
                              : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-400'
                          )}
                          disabled={!activeConversationId || submitting || !prompt.trim() || !chatSettings.model}
                          title="发送"
                        >
                          <SendHorizontal className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </div>
                </form>
                
                {error && (
                  <div className="mx-auto max-w-5xl mt-2 animate-enter">
                    <p className="text-sm text-red-500 flex items-center gap-2">
                      <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />
                      {error}
                    </p>
                  </div>
                )}
                {fileUploadError && (
                  <div className="mx-auto max-w-5xl mt-2 animate-enter">
                    <p className="text-sm text-red-500">附件上传失败：{fileUploadError}</p>
                  </div>
                )}
                
                {!activeConversationId && (
                  <p className="mx-auto max-w-5xl mt-2 text-xs text-muted-foreground/60 text-center">
                    请先选择或创建一个会话开始对话
                  </p>
                )}
              </div>
            </div>
          </div>

          <aside className={cn('hidden border-l border-surface-outline/80 bg-surface-subtle transition-all duration-300 lg:block', settingsOpen ? 'w-[320px] opacity-100' : 'w-0 overflow-hidden opacity-0')}>
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex items-center justify-between border-b border-surface-outline/80 px-4 py-4">
                <div>
                  <p className="text-sm font-semibold text-foreground">聊天设置</p>
                  <p className="mt-1 text-xs text-muted-foreground">右侧独立折叠，不打断中间聊天阅读。</p>
                </div>
                <Button type="button" variant="ghost" size="icon" className="h-8 w-8 rounded-full" onClick={() => setSettingsOpen(false)}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>

              <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
                <div className="space-y-2">
                  <Label>模型</Label>
                  <Select
                    value={chatSettings.model}
                    onValueChange={(value) => setChatSettings((prev) => ({ ...prev, model: value }))}
                    disabled={loadingConfig || !chatConfig?.models.length || submitting}
                  >
                    <SelectTrigger className="bg-surface-panel">
                      <SelectValue placeholder={loadingConfig ? '加载模型中...' : '选择模型'} />
                    </SelectTrigger>
                    <SelectContent>
                      {(() => {
                        const premiumModels = chatConfig?.premiumModels || []
                        const basicModels = chatConfig?.basicModels || []
                        return (
                          <>
                            {premiumModels.length > 0 && (
                              <SelectGroup>
                                <SelectLabel>高级模型</SelectLabel>
                                {premiumModels.map((model) => (
                                  <SelectItem key={model} value={model}>
                                    {model}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            )}
                            {basicModels.length > 0 && (
                              <SelectGroup>
                                <SelectLabel>基础模型</SelectLabel>
                                {basicModels.map((model) => (
                                  <SelectItem key={model} value={model}>
                                    {model}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            )}
                          </>
                        )
                      })()}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>总结总览</Label>
                  <Select
                    value={chatSettings.overviewPromptId}
                    onValueChange={(value) => setChatSettings((prev) => ({ ...prev, overviewPromptId: value }))}
                    disabled={loadingConfig || submitting}
                  >
                    <SelectTrigger className="bg-surface-panel">
                      <SelectValue placeholder="选择总结总览模板" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">不使用</SelectItem>
                      {(chatConfig?.overviewOptions || []).map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs leading-5 text-muted-foreground">
                    {chatConfig?.overviewOptions.find((item) => item.id === chatSettings.overviewPromptId)?.description || '不追加总结总览段落'}
                  </p>
                </div>

                <div className="space-y-2">
                  <Label>明细</Label>
                  <Select
                    value={chatSettings.detailPromptId}
                    onValueChange={(value) => setChatSettings((prev) => ({ ...prev, detailPromptId: value }))}
                    disabled={loadingConfig || submitting}
                  >
                    <SelectTrigger className="bg-surface-panel">
                      <SelectValue placeholder="选择明细模板" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">不使用</SelectItem>
                      {(chatConfig?.detailOptions || []).map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs leading-5 text-muted-foreground">
                    {chatConfig?.detailOptions.find((item) => item.id === chatSettings.detailPromptId)?.description || '不追加明细段落'}
                  </p>
                </div>

                <div className="rounded-2xl border border-surface-outline/80 bg-surface-panel p-4">
                  <p className="text-sm font-medium text-foreground">运行状态</p>
                  <div className="mt-3 space-y-2 text-sm text-muted-foreground">
                    <div className="flex items-center justify-between">
                      <span>AI Provider</span>
                      <span>{chatConfig?.providerConfigured ? '已就绪' : '未配置'}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>联网搜索</span>
                      <span>{chatConfig?.webSearchConfigured ? '已就绪' : '未配置'}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>超时</span>
                      <span>{chatConfig?.timeoutSeconds ?? '--'} 秒</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>最大对话轮次</span>
                      <span>{chatConfig?.maxConversationTurns ?? 10} 次</span>
                    </div>
                  </div>
                </div>

                {lastTokenUsage ? (
                  <div className="rounded-2xl border border-surface-outline/80 bg-surface-panel p-4">
                    <p className="text-sm font-medium text-foreground">上次对话统计</p>
                    <div className="mt-3 space-y-2 text-sm text-muted-foreground">
                      <div className="flex items-center justify-between">
                        <span>Prompt Tokens</span>
                        <span>{lastTokenUsage.prompt_tokens}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>Completion Tokens</span>
                        <span>{lastTokenUsage.completion_tokens}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>总 Tokens</span>
                        <span>{lastTokenUsage.total_tokens}</span>
                      </div>
                      {lastDurationMs ? (
                        <div className="flex items-center justify-between">
                          <span>耗时</span>
                          <span>{(lastDurationMs / 1000).toFixed(2)} 秒</span>
                        </div>
                      ) : null}
                      {lastTokenUsage.total_tokens && lastDurationMs ? (
                        <div className="flex items-center justify-between">
                          <span>速度</span>
                          <span>{(lastTokenUsage.total_tokens / (lastDurationMs / 1000)).toFixed(1)} tokens/s</span>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </aside>
        </section>
      </div>
    </div>
  )
}
