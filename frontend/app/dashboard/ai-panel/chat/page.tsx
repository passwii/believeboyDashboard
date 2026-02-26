'use client'

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { Bot, MessageCirclePlus, SendHorizontal, User } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
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

type LLMConfigForm = {
  baseUrl: string
  apiKey: string
  model: string
  timeoutSeconds: string
  systemPrompt: string
}

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? ''
const API_KEY = process.env.NEXT_PUBLIC_BACKEND_API_KEY ?? ''
const LLM_CONFIG_STORAGE_KEY = 'believeboy-ai-llm-config-v1'

const defaultLlmConfig: LLMConfigForm = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  timeoutSeconds: '90',
  systemPrompt: '你是 BelieveBoy Dashboard 的运营数据助手，请给出清晰、可执行的建议。',
}

function authHeaders(): Record<string, string> {
  return API_KEY ? { 'X-API-Key': API_KEY } : {}
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
  const [llmConfig, setLlmConfig] = useState<LLMConfigForm>(defaultLlmConfig)
  const [loadingConversations, setLoadingConversations] = useState(false)
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const activeConversation = useMemo(
    () => conversations.find((item) => item.id === activeConversationId) ?? null,
    [activeConversationId, conversations]
  )

  const isLlmConfigValid = useMemo(() => {
    return Boolean(llmConfig.baseUrl.trim() && llmConfig.apiKey.trim() && llmConfig.model.trim())
  }, [llmConfig.apiKey, llmConfig.baseUrl, llmConfig.model])

  const loadConversations = useCallback(async () => {
    setLoadingConversations(true)
    setError(null)
    try {
      const response = await fetch(`${API_BASE}/api/v1/ai/conversations`, {
        headers: authHeaders(),
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
      const response = await fetch(`${API_BASE}/api/v1/ai/conversations/${conversationId}/messages`, {
        headers: authHeaders(),
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
      const response = await fetch(`${API_BASE}/api/v1/ai/conversations`, {
        method: 'POST',
        headers: {
          ...authHeaders(),
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
    if (!isLlmConfigValid) {
      setError('请先填写 LLM Base URL / API Key / Model')
      return
    }

    setSubmitting(true)
    setError(null)

    const parsedTimeout = Number.parseInt(llmConfig.timeoutSeconds, 10)
    const timeoutSeconds = Number.isFinite(parsedTimeout) ? Math.max(10, Math.min(300, parsedTimeout)) : 90

    try {
      const response = await fetch(`${API_BASE}/api/v1/ai/conversations/${activeConversationId}/messages`, {
        method: 'POST',
        headers: {
          ...authHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content,
          llm_config: {
            base_url: llmConfig.baseUrl.trim(),
            api_key: llmConfig.apiKey.trim(),
            model: llmConfig.model.trim(),
            timeout_seconds: timeoutSeconds,
            system_prompt: llmConfig.systemPrompt,
          },
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
  }, [activeConversationId, isLlmConfigValid, llmConfig, loadConversations, prompt, submitting])

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(LLM_CONFIG_STORAGE_KEY)
      if (!raw) {
        return
      }
      const parsed = JSON.parse(raw) as Partial<LLMConfigForm>
      setLlmConfig((prev) => ({
        ...prev,
        ...parsed,
      }))
    } catch {
      // Ignore invalid localStorage payload.
    }
  }, [])

  useEffect(() => {
    window.localStorage.setItem(LLM_CONFIG_STORAGE_KEY, JSON.stringify(llmConfig))
  }, [llmConfig])

  useEffect(() => {
    void loadConversations()
  }, [loadConversations])

  useEffect(() => {
    if (activeConversationId) {
      void loadMessages(activeConversationId)
    }
  }, [activeConversationId, loadMessages])

  return (
    <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
      <Card className="dashboard-surface">
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
                    activeConversationId === item.id ? 'bg-primary/10 text-primary' : 'hover:bg-muted'
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

      <Card className="dashboard-surface">
        <CardHeader>
          <CardTitle className="text-base">{activeConversation?.title || '请选择或新建会话'}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2 rounded-lg border bg-muted/20 p-3 lg:grid-cols-2">
            <Input
              value={llmConfig.baseUrl}
              onChange={(event) => setLlmConfig((prev) => ({ ...prev, baseUrl: event.target.value }))}
              placeholder="OpenAI兼容 Base URL"
            />
            <Input
              type="password"
              value={llmConfig.apiKey}
              onChange={(event) => setLlmConfig((prev) => ({ ...prev, apiKey: event.target.value }))}
              placeholder="LLM API Key"
            />
            <Input
              value={llmConfig.model}
              onChange={(event) => setLlmConfig((prev) => ({ ...prev, model: event.target.value }))}
              placeholder="模型名称 (例如 gpt-4o-mini)"
              list="llm-model-options"
            />
            <Input
              value={llmConfig.timeoutSeconds}
              onChange={(event) => setLlmConfig((prev) => ({ ...prev, timeoutSeconds: event.target.value }))}
              placeholder="超时秒数(10-300)"
            />
            <Input
              className="lg:col-span-2"
              value={llmConfig.systemPrompt}
              onChange={(event) => setLlmConfig((prev) => ({ ...prev, systemPrompt: event.target.value }))}
              placeholder="系统提示词（可选）"
            />
            <datalist id="llm-model-options">
              <option value="gpt-4o-mini" />
              <option value="gpt-4.1-mini" />
              <option value="gpt-4.1" />
            </datalist>
          </div>

          <ScrollArea className="h-[390px] rounded-lg border bg-muted/20 p-3">
            <div className="space-y-3">
              {loadingMessages ? <p className="text-sm text-muted-foreground">加载消息中...</p> : null}
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={cn(
                    'flex gap-2 rounded-md border p-3 text-sm',
                    message.role === 'assistant' ? 'bg-background' : 'bg-primary/5'
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
            <Button type="submit" disabled={!activeConversationId || submitting || !prompt.trim() || !isLlmConfigValid}>
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
