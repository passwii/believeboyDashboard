'use client'

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { Bot, MessageCirclePlus, SendHorizontal, Settings2, User } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

type ConversationItem = {
  id: number
  title: string
  created_at: string
  updated_at: string
}

type MessageItem = {
  id: number
  conversation_id: number
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

type MessageCreateResponse = {
  user_message: MessageItem
  assistant_message: MessageItem
}

type PromptOption = {
  id: string
  label: string
  description: string
}

type ChatConfigResponse = {
  providerConfigured: boolean
  models: string[]
  defaultModel: string
  timeoutSeconds: number
  overviewOptions: PromptOption[]
  detailOptions: PromptOption[]
  message?: string
}

type ChatSettings = {
  model: string
  overviewPromptId: string
  detailPromptId: string
}

const CHAT_SETTINGS_STORAGE_KEY = 'believeboy-ai-chat-settings-v2'

const defaultChatSettings: ChatSettings = {
  model: '',
  overviewPromptId: 'overview-standard',
  detailPromptId: 'detail-standard',
}

async function parseError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { detail?: string; message?: string }
    return payload.detail || payload.message || `请求失败 (${response.status})`
  } catch {
    return `请求失败 (${response.status})`
  }
}

export default function AIChatPage() {
  const [conversations, setConversations] = useState<ConversationItem[]>([])
  const [activeConversationId, setActiveConversationId] = useState<number | null>(null)
  const [messages, setMessages] = useState<MessageItem[]>([])
  const [prompt, setPrompt] = useState('')
  const [chatConfig, setChatConfig] = useState<ChatConfigResponse | null>(null)
  const [chatSettings, setChatSettings] = useState<ChatSettings>(defaultChatSettings)
  const [loadingConfig, setLoadingConfig] = useState(false)
  const [loadingConversations, setLoadingConversations] = useState(false)
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const activeConversation = useMemo(
    () => conversations.find((item) => item.id === activeConversationId) ?? null,
    [activeConversationId, conversations]
  )

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
        model: payload.models.includes(prev.model) ? prev.model : payload.defaultModel || payload.models[0] || '',
        overviewPromptId:
          payload.overviewOptions.some((item) => item.id === prev.overviewPromptId)
            ? prev.overviewPromptId
            : defaultChatSettings.overviewPromptId,
        detailPromptId:
          payload.detailOptions.some((item) => item.id === prev.detailPromptId)
            ? prev.detailPromptId
            : defaultChatSettings.detailPromptId,
      }))
      if (payload.message) {
        setError(payload.message)
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载配置失败')
    } finally {
      setLoadingConfig(false)
    }
  }, [])

  const loadConversations = useCallback(async () => {
    setLoadingConversations(true)
    setError(null)
    try {
      const response = await fetch('/api/ai-chat/conversations', {
        method: 'GET',
        cache: 'no-store',
      })
      if (!response.ok) {
        throw new Error(await parseError(response))
      }
      const payload = (await response.json()) as ConversationItem[]
      setConversations(payload)
      if (!activeConversationId && payload.length > 0) {
        setActiveConversationId(payload[0].id)
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载会话失败')
    } finally {
      setLoadingConversations(false)
    }
  }, [activeConversationId])

  const loadMessages = useCallback(async (conversationId: number) => {
    setLoadingMessages(true)
    setError(null)
    try {
      const response = await fetch(`/api/ai-chat/conversations/${conversationId}/messages`, {
        method: 'GET',
        cache: 'no-store',
      })
      if (!response.ok) {
        throw new Error(await parseError(response))
      }
      const payload = (await response.json()) as MessageItem[]
      setMessages(payload)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载消息失败')
    } finally {
      setLoadingMessages(false)
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
        throw new Error(await parseError(response))
      }
      const payload = (await response.json()) as ConversationItem
      setConversations((prev) => [payload, ...prev])
      setActiveConversationId(payload.id)
      setMessages([])
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : '创建会话失败')
    }
  }, [])

  const handleSend = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const content = prompt.trim()
    if (!content || !activeConversationId || submitting) {
      return
    }
    if (!chatConfig?.providerConfigured) {
      setError('AI Provider 未配置，请先在 .env.local 中设置')
      return
    }
    if (!chatSettings.model) {
      setError('请选择模型')
      return
    }

    setSubmitting(true)
    setError(null)

    try {
      const response = await fetch(`/api/ai-chat/conversations/${activeConversationId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content,
          model: chatSettings.model,
          overviewPromptId: chatSettings.overviewPromptId,
          detailPromptId: chatSettings.detailPromptId,
        }),
      })
      if (!response.ok) {
        throw new Error(await parseError(response))
      }

      const payload = (await response.json()) as MessageCreateResponse
      setMessages((prev) => [...prev, payload.user_message, payload.assistant_message])
      setPrompt('')
      await loadConversations()
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : '发送失败')
    } finally {
      setSubmitting(false)
    }
  }, [activeConversationId, chatConfig?.providerConfigured, chatSettings, loadConversations, prompt, submitting])

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

  useEffect(() => {
    void loadConfig()
    void loadConversations()
  }, [loadConfig, loadConversations])

  useEffect(() => {
    if (activeConversationId) {
      void loadMessages(activeConversationId)
    }
  }, [activeConversationId, loadMessages])

  return (
    <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
      <Card className="dashboard-surface dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">AI 会话</CardTitle>
          <Button size="sm" onClick={() => void createConversation()}>
            <MessageCirclePlus className="mr-1.5 h-4 w-4" />
            新建
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollArea className="h-[560px]">
            <div className="space-y-1 p-3">
              {loadingConversations ? <p className="px-2 py-1 text-sm text-muted-foreground">加载中...</p> : null}
              {conversations.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveConversationId(item.id)}
                  className={cn(
                    'w-full rounded-md px-3 py-2 text-left text-sm transition-colors',
                    activeConversationId === item.id
                      ? 'bg-primary/10 text-primary dark:bg-primary/15 dark:text-primary'
                      : 'hover:bg-muted dark:hover:bg-[hsl(var(--surface-strong)/0.45)]'
                  )}
                >
                  <p className="line-clamp-1 font-medium">{item.title}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{new Date(item.updated_at).toLocaleString()}</p>
                </button>
              ))}
              {!loadingConversations && conversations.length === 0 ? (
                <p className="px-2 py-1 text-sm text-muted-foreground">暂无会话，请先新建。</p>
              ) : null}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      <Card className="dashboard-surface dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]">
        <CardHeader>
          <CardTitle className="text-base">{activeConversation?.title || '请选择或新建会话'}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="rounded-xl border bg-muted/20 p-4 dark:border-border/80 dark:bg-[hsl(var(--surface-soft))]">
            <div className="mb-4 flex items-center gap-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Settings2 className="h-4 w-4" />
              </div>
              <div>
                <p className="text-sm font-medium">聊天配置</p>
                <p className="text-xs text-muted-foreground">
                  运营只需要选择模型和两段系统提示词，不再手动填写 endpoint 或 key。
                </p>
              </div>
            </div>

            <div className="grid gap-3 lg:grid-cols-3">
              <div className="space-y-2">
                <Label>模型</Label>
                <Select
                  value={chatSettings.model}
                  onValueChange={(value) => setChatSettings((prev) => ({ ...prev, model: value }))}
                  disabled={loadingConfig || !chatConfig?.models.length}
                >
                  <SelectTrigger>
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
                  disabled={loadingConfig}
                >
                  <SelectTrigger>
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
                <p className="text-xs text-muted-foreground">
                  {chatConfig?.overviewOptions.find((item) => item.id === chatSettings.overviewPromptId)?.description ||
                    '不追加总结总览段落'}
                </p>
              </div>

              <div className="space-y-2">
                <Label>明细</Label>
                <Select
                  value={chatSettings.detailPromptId}
                  onValueChange={(value) => setChatSettings((prev) => ({ ...prev, detailPromptId: value }))}
                  disabled={loadingConfig}
                >
                  <SelectTrigger>
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
                <p className="text-xs text-muted-foreground">
                  {chatConfig?.detailOptions.find((item) => item.id === chatSettings.detailPromptId)?.description ||
                    '不追加明细段落'}
                </p>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span>Provider 配置：{chatConfig?.providerConfigured ? '已就绪' : '未配置'}</span>
              <span>超时：{chatConfig?.timeoutSeconds ?? '--'} 秒</span>
            </div>
          </div>

          <ScrollArea className="h-[390px] rounded-lg border bg-muted/20 p-3 dark:border-border/80 dark:bg-[hsl(var(--surface-soft))]">
            <div className="space-y-3">
              {loadingMessages ? <p className="text-sm text-muted-foreground">加载消息中...</p> : null}
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={cn(
                    'flex gap-2 rounded-md border p-3 text-sm',
                    message.role === 'assistant'
                      ? 'bg-background dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]'
                      : 'bg-primary/5 dark:border-primary/20 dark:bg-primary/10'
                  )}
                >
                  <div className="pt-0.5">
                    {message.role === 'assistant' ? <Bot className="h-4 w-4 text-primary" /> : <User className="h-4 w-4" />}
                  </div>
                  <p className="whitespace-pre-wrap leading-6">{message.content}</p>
                </div>
              ))}
              {!loadingMessages && messages.length === 0 ? (
                <p className="text-sm text-muted-foreground">发送第一条消息开始对话。</p>
              ) : null}
            </div>
          </ScrollArea>

          <form onSubmit={handleSend} className="flex items-center gap-2">
            <Input
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="输入你的问题，例如：帮我分析本周广告成本波动"
              disabled={!activeConversationId || submitting}
            />
            <Button type="submit" disabled={!activeConversationId || submitting || !prompt.trim() || !chatSettings.model}>
              <SendHorizontal className="mr-1.5 h-4 w-4" />
              发送
            </Button>
          </form>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </CardContent>
      </Card>
    </div>
  )
}
