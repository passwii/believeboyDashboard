'use client'

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  Bot,
  ChevronLeft,
  ChevronRight,
  FileText,
  Globe,
  Loader2,
  MessageCirclePlus,
  Paperclip,
  RefreshCw,
  SendHorizontal,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  User,
  X,
} from 'lucide-react'

import { AIChatMessageContent } from '@/components/ai-chat-message-content'
import { AIChatSearchSources } from '@/components/ai-chat-search-sources'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { parseResponseError } from '@/lib/error-utils'
import { cn } from '@/lib/utils'

type ConversationItem = {
  id: number
  title: string
  created_at: string
  updated_at: string
}

type ChatMessage = {
  id: number | string
  conversation_id: number
  role: 'user' | 'assistant'
  content: string
  search_sources?: SearchSource[]
  created_at: string
  streaming?: boolean
  failed?: boolean
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


const defaultChatSettings: ChatSettings = {
  model: '',
  overviewPromptId: 'none',
  detailPromptId: 'none',
  enableWebSearch: false,
  maxConversationTurns: 10,
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
  const [leftPanelOpen, setLeftPanelOpen] = useState(true)
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
  const chatScrollRef = useRef<HTMLDivElement | null>(null)
  const messageRequestRef = useRef(0)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const activeRequestControllerRef = useRef<AbortController | null>(null)
  const nextScrollBehaviorRef = useRef<ScrollBehavior | null>(null)

  const activeConversation = useMemo(
    () => conversations.find((item) => item.id === activeConversationId) ?? null,
    [activeConversationId, conversations]
  )

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
      setChatSettings((prev) => ({
        ...prev,
        model: payload.models.includes(prev.model) ? prev.model : payload.defaultModel || payload.models[0] || '',
        overviewPromptId:
          payload.overviewOptions.some((item) => item.id === prev.overviewPromptId)
            ? prev.overviewPromptId
            : defaultChatSettings.overviewPromptId,
        detailPromptId:
          payload.detailOptions.some((item) => item.id === prev.detailPromptId)
            ? prev.detailPromptId
            : defaultChatSettings.detailPromptId,
        maxConversationTurns: payload.maxConversationTurns || 10,
      }))
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
      nextScrollBehaviorRef.current = 'auto'
      setMessages(payload)
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
      // Abort any in-flight streaming request so pending messages persist
      // in the old conversation's message list and complete in the background.
      if (activeRequestControllerRef.current) {
        activeRequestControllerRef.current.abort()
      }
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
      const confirmed = window.confirm('删除后该会话及消息不可恢复，确认继续吗？')
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
      setConversations((prev) => upsertConversation(prev, payload.conversation))
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
    async (options: { content?: string; regenerate?: boolean }) => {
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
      if (regenerate && !regenerationTarget) {
        setError('当前没有可重新生成的回答')
        return
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
      activeRequestControllerRef.current = controller

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
              .filter((item) => item.id !== assistantTempId && item.id !== regenerationTarget?.assistant.id)
              .concat({ ...streamEvent.assistant_message, streaming: false, failed: false })
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
        activeRequestControllerRef.current = null
        setSubmitting(false)
      }
    },
    [activeConversationId, chatConfig?.providerConfigured, chatSettings, regenerationTarget, submitting, attachedFile]
  )

  const handleSend = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      await runMessageStream({ content: prompt })
    },
    [prompt, runMessageStream]
  )

  const handleStopGenerating = useCallback(() => {
    activeRequestControllerRef.current?.abort()
  }, [])

  const handleRegenerateReply = useCallback(async () => {
    await runMessageStream({ regenerate: true })
  }, [runMessageStream])

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
    window.localStorage.setItem(CHAT_SETTINGS_STORAGE_KEY, JSON.stringify(chatSettings))
  }, [chatSettings])

  useEffect(() => () => activeRequestControllerRef.current?.abort(), [])

  useEffect(() => {
    void loadConfig()
    void loadConversations()
  }, [loadConfig, loadConversations])

  useEffect(() => {
    if (!activeConversationId) {
      setMessages([])
      setLoadingMessages(false)
      return
    }
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
      <div className="grid h-full min-h-0 grid-cols-[72px_minmax(0,1fr)] lg:grid-cols-[272px_minmax(0,1fr)]">
        <aside className="min-h-0 border-r border-surface-outline/80 bg-surface-subtle">
          <div className="flex h-full min-h-0 flex-col">
              <div className="flex items-center justify-between border-b border-surface-outline/80 px-3 py-3">
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 rounded-full text-muted-foreground"
                  onClick={() => setLeftPanelOpen((prev) => !prev)}
                  title={leftPanelOpen ? '收起会话列表' : '展开会话列表'}
                >
                  {leftPanelOpen ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </Button>
              </div>
              <Button
                type="button"
                size="sm"
                className={cn(
                  'rounded-full bg-surface-panel text-foreground hover:bg-surface-soft',
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
              <div className="min-h-0 flex-1">
                <ScrollArea className="h-full">
                  <div className="space-y-1.5 px-2 py-2">

                    {loadingConversations ? (
                      <div className="flex items-center gap-2 px-2 py-2 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>加载中</span>
                      </div>
                    ) : null}
                    {conversations.map((item) => {
                      const titleActionBusy = busyConversationAction === `title-${item.id}`
                      const deleteActionBusy = busyConversationAction === `delete-${item.id}`
                      const active = activeConversationId === item.id

                      return (
                        <div
                          key={item.id}
                          className={cn(
                            'group rounded-lg px-2 py-1 transition-all',
                            active
                              ? 'bg-surface-panel shadow-[0_1px_2px_rgba(15,23,42,0.08)] dark:shadow-[0_1px_2px_rgba(0,0,0,0.3)]'
                              : 'hover:bg-surface-panel/80'
                          )}
                        >
                          <div className="flex items-center gap-1.5">
                            <button type="button" onClick={() => setActiveConversationId(item.id)} className="min-w-0 flex-1 text-left">
                              <p className="truncate text-[0.79rem] font-medium leading-5 text-foreground">{item.title}</p>
                            </button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 shrink-0 rounded-full text-muted-foreground opacity-100 lg:opacity-0 lg:group-hover:opacity-100"
                              disabled={titleActionBusy || deleteActionBusy}
                              onClick={() => void handleRegenerateTitle(item.id)}
                              title="重生成话题"
                            >
                              {titleActionBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 shrink-0 rounded-full text-muted-foreground hover:text-red-500 opacity-100 lg:opacity-0 lg:group-hover:opacity-100"
                              disabled={titleActionBusy || deleteActionBusy || submitting}
                              onClick={() => void handleDeleteConversation(item.id)}
                              title="删除会话"
                            >
                              {deleteActionBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                            </Button>
                          </div>
                        </div>
                      )
                    })}
                    {!loadingConversations && conversations.length === 0 ? (
                      <p className="px-2 py-2 text-sm text-muted-foreground">暂无会话，请先新建。</p>
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
            <header className="border-b border-surface-outline/80 px-5 py-2">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h1 className="truncate text-[1.3rem] font-semibold tracking-tight text-foreground">
                      {activeConversation?.title || 'AI 聊天面板'}
                    </h1>
                    {refreshingPanel ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : loadingMessages ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" className="rounded-full" onClick={() => void handleRefreshPanel()} disabled={refreshingPanel}>
                    {refreshingPanel ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                    刷新
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-full text-red-500 hover:text-red-500"
                    disabled={!activeConversationId || submitting || busyConversationAction === `delete-${activeConversationId}`}
                    onClick={() => activeConversationId && void handleDeleteConversation(activeConversationId)}
                  >
                    {busyConversationAction === `delete-${activeConversationId}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                    删除当前
                  </Button>
                  <Button
                    variant={settingsOpen ? 'default' : 'outline'}
                    size="sm"
                    className="rounded-full"
                    onClick={() => setSettingsOpen((prev) => !prev)}
                  >
                    <Settings2 className="h-4 w-4" />
                    设置
                  </Button>
                </div>
              </div>
            </header>

            <div className="min-h-0 flex-1 overflow-hidden">
              <div ref={chatScrollRef} onScroll={(event) => setAutoScrollEnabled(isNearBottom(event.currentTarget))} className="h-full overflow-y-auto px-6 py-2">
                <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col justify-end space-y-5">
                  {messages.map((message) => (
                    <div key={message.id} className={cn('flex', message.role === 'user' ? 'justify-end' : 'justify-start')}>
                      <div
                        className={cn(
                          'gap-3 rounded-[28px] text-sm',
                          message.role === 'assistant'
                            ? 'flex w-full max-w-4xl px-4 py-3'
                            : 'inline-flex w-fit max-w-[70%] flex-row-reverse border border-amber-200 bg-amber-50 px-4 py-3 text-amber-950',
                          message.failed ? 'border border-red-300 bg-red-50' : ''
                        )}
                      >
                        <div className="pt-0.5">
                          {message.role === 'assistant' ? <Bot className="h-4 w-4 text-muted-foreground" /> : <User className="h-4 w-4 text-amber-600" />}
                        </div>
                        <div className={cn('min-w-0', message.role === 'assistant' ? 'flex-1' : '')}>
                          {message.role === 'assistant' ? (
                            <>
                              {/* 搜索来源显示在顶部 */}
                              {message.search_sources?.length ? (
                                <AIChatSearchSources sources={message.search_sources} className="mt-0 mb-3" />
                              ) : null}
                              {message.content ? (
                                <AIChatMessageContent content={message.content} className="[&_p]:text-[15px] [&_p]:leading-7" />
                              ) : message.search_sources?.length ? (
                                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                  <span>AI 正在基于搜索结果生成回答...</span>
                                </div>
                              ) : (
                                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                  <span>模型正在思考中...</span>
                                </div>
                              )}
                              {message.streaming ? (
                                <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  <span>持续生成中</span>
                                </div>
                              ) : null}
                              {isToolSearching && message.streaming ? (
                                <div className="mt-3 flex items-center gap-2 text-xs text-blue-500 dark:text-blue-400">
                                  <Globe className="h-3.5 w-3.5 animate-pulse" />
                                  <span>搜索中: {searchingQuery}...</span>
                                </div>
                              ) : null}
                            </>
                          ) : (
                            <p className="whitespace-pre-wrap break-words text-[15px] leading-7">{message.content}</p>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}

                  {!loadingMessages && messages.length === 0 ? (
                    <div className="mx-auto flex max-w-2xl flex-col items-center py-12 text-center">
                      <h2 className="mt-4 text-3xl font-semibold tracking-tight text-foreground">直接输入你的问题开始对话</h2>
                      <p className="mt-3 text-sm leading-6 text-muted-foreground">右侧区域只保留聊天内容和输入，不再额外包一层画布。</p>
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
                    className="pointer-events-auto h-11 w-11 rounded-full shadow-[0_12px_32px_rgba(15,23,42,0.14)]"
                    onClick={() => scrollToBottom('smooth')}
                    title="回到底部并恢复跟随"
                  >
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                </div>
              ) : null}
            </div>

            <div className="sticky bottom-0 z-20 border-t border-surface-outline/80 bg-surface-subtle px-5 py-2">
              <form onSubmit={handleSend} className="mx-auto flex w-full max-w-5xl flex-col gap-3">
                <div className="rounded-[26px] border border-surface-outline/80 bg-surface-subtle/90 px-4 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.75)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className={cn(
                        'h-10 w-10 shrink-0 rounded-full border-surface-outline/80 bg-surface-panel',
                        attachedFile ? 'text-foreground bg-surface-subtle' : 'text-muted-foreground'
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
                      variant={chatSettings.enableWebSearch ? 'default' : 'outline'}
                      size="icon"
                      className={cn(
                        'h-10 w-10 shrink-0 rounded-full',
                        chatSettings.enableWebSearch
                          ? 'bg-surface-panel text-foreground hover:bg-surface-soft'
                          : 'border-surface-outline/80 bg-surface-panel text-muted-foreground'
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
                    <Input
                      value={prompt}
                      onChange={(event) => setPrompt(event.target.value)}
                      placeholder="输入你的问题，或附加文件后提问"
                      disabled={!activeConversationId || submitting}
                      className="border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
                    />
                    {canRegenerate ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-10 w-10 shrink-0 rounded-full border-surface-outline/80 bg-surface-panel"
                        onClick={() => void handleRegenerateReply()}
                        title="重新生成回答"
                      >
                        <RefreshCw className="h-4 w-4" />
                      </Button>
                    ) : null}
                    {submitting ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-10 w-10 shrink-0 rounded-full border-surface-outline/80 bg-surface-panel"
                        onClick={handleStopGenerating}
                        title="停止生成"
                      >
                        <Square className="h-4 w-4" />
                      </Button>
                    ) : null}
                    <Button
                      type="submit"
                      size="icon"
                      className="h-10 w-10 shrink-0 rounded-full bg-surface-panel text-foreground hover:bg-surface-soft"
                      disabled={!activeConversationId || submitting || !prompt.trim() || !chatSettings.model}
                      title="发送"
                    >
                      <SendHorizontal className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                {error ? <p className="text-sm text-red-600">{error}</p> : null}
                {fileUploadError ? <p className="text-sm text-red-600">附件：{fileUploadError}</p> : null}
                {attachedFile ? (
                  <div className="flex items-center gap-2 rounded-xl border border-surface-outline/80 bg-surface-subtle px-3 py-2 text-sm">
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-foreground">{attachedFile.fileName}</p>
                      {attachedFile.truncatedNote ? (
                        <p className="text-xs text-amber-500">{attachedFile.truncatedNote}</p>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      onClick={handleRemoveAttachedFile}
                      className="shrink-0 rounded-full p-1 text-muted-foreground hover:bg-surface-soft hover:text-foreground"
                      title="移除附件"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : null}
              </form>
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
                      {(chatConfig?.models || []).map((model) => (
                        <SelectItem key={model} value={model}>
                          {model}
                        </SelectItem>
                      ))}
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
