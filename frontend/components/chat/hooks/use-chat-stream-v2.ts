/**
 * useChatStream V2 — drives a single backend streaming turn via Anthropic SSE protocol.
 *
 * Changes from V1:
 *   - Uses `consumeStreamV2` (SSE parser) instead of `consumeStream` (ndjson parser)
 *   - `stop()` calls the backend cancel endpoint (cross-worker cancel via Redis GETDEL)
 *   - Tracks Last-Event-ID for resume/reconnect support
 *   - Accept header: text/event-stream
 *
 * The hook interface is identical to V1 — callers don't need to change.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import {
  consumeStreamV2,
  type V2ProtocolEvent,
} from '@/lib/api/ai-chat-stream-v2'
import type {
  StreamCallbacks,
  StreamDonePayload,
  StreamUsage,
} from '@/lib/api/ai-chat-stream-v2'
import type { SearchSource } from '@/lib/api/ai-chat'

export type ChatStreamOptions = {
  model?: string
  reasoningEffort?: string | null
  regenerate?: boolean
  targetMessageId?: number
  overviewPromptId?: string | null
  detailPromptId?: string | null
  scenarioId?: string | null
  toneId?: string | null
  language?: string | null
  length?: string | null
  enableWebSearch?: boolean
  attachedFileContent?: string | null
  attachedFileName?: string | null
}

export type UseChatStreamCallbacks = StreamCallbacks & {
  onUserMessageId?: (id: number) => void
  onAssistantId?: (id: number) => void
  onTitleUpdate?: (title: string) => void
}

export type UseChatStreamResult = {
  send: (content: string, options?: ChatStreamOptions) => Promise<StreamDonePayload>
  stop: () => void
  isStreaming: boolean
  error: string | null
  toolState: { toolCallsCount: number; searching: boolean; done: boolean } | null
  pendingSources: SearchSource[]
  pendingUsage: StreamUsage | null
}

export function useChatStreamV2(
  conversationIdRef: React.RefObject<number | null>,
  callbacksRef: React.MutableRefObject<UseChatStreamCallbacks>
): UseChatStreamResult {
  const abortRef = useRef<AbortController | null>(null)
  const lastEventIdRef = useRef<string | null>(null)
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toolState, setToolState] = useState<UseChatStreamResult['toolState']>(null)
  const [pendingSources, setPendingSources] = useState<SearchSource[]>([])
  const [pendingUsage, setPendingUsage] = useState<StreamUsage | null>(null)

  const resetTurnState = useCallback(() => {
    setToolState(null)
    setPendingSources([])
    setPendingUsage(null)
    lastEventIdRef.current = null
  }, [])

  const stop = useCallback(() => {
    const cid = conversationIdRef.current
    abortRef.current?.abort()
    abortRef.current = null
    setIsStreaming(false)

    // V2: 调后端取消端点(跨 worker 生效)
    if (cid != null) {
      fetch(`/api/ai-chat/conversations/${cid}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }).catch(() => {
        // 取消失败不影响 UI(流可能已结束)
      })
    }
  }, [conversationIdRef])

  const send = useCallback(
    async (content: string, options: ChatStreamOptions = {}): Promise<StreamDonePayload> => {
      const cid = conversationIdRef.current
      if (cid == null) {
        const msg = 'No active conversation'
        setError(msg)
        throw new Error(msg)
      }

      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      setIsStreaming(true)
      setError(null)
      resetTurnState()

      const cb =
        (name: keyof UseChatStreamCallbacks) =>
        (...args: unknown[]) => {
          const fn = callbacksRef.current[name] as ((...a: unknown[]) => void) | undefined
          fn?.(...args)
        }

      const streamCallbacks: StreamCallbacks = {
        onStart: cb('onStart') as () => void,
        onChunk: cb('onChunk') as (delta: string) => void,
        onThinking: cb('onThinking') as (delta: string) => void,
        onSources: (sources, meta) => {
          setPendingSources(sources)
          cb('onSources')(sources, meta)
        },
        onUsage: (usage) => {
          setPendingUsage(usage)
          cb('onUsage')(usage)
        },
        onToolState: (state) => {
          setToolState(state)
          cb('onToolState')(state)
        },
        onDone: (payload) => {
          callbacksRef.current.onUserMessageId?.(payload.userMessage.id)
          callbacksRef.current.onAssistantId?.(payload.assistantMessage.id)
          if (payload.titleRegenerated && payload.conversationTitle) {
            callbacksRef.current.onTitleUpdate?.(payload.conversationTitle)
          }
          cb('onDone')(payload)
        },
        onError: (message) => {
          setError(message)
          cb('onError')(message)
        },
      }

      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        }
        // V2 重连:传 Last-Event-ID
        if (lastEventIdRef.current) {
          headers['Last-Event-ID'] = lastEventIdRef.current
        }

        const res = await fetch(`/api/ai-chat/conversations/${cid}/messages/stream`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            content,
            model: options.model,
            reasoningEffort: options.reasoningEffort ?? null,
            regenerate: options.regenerate ?? false,
            target_message_id: options.targetMessageId,
            overviewPromptId: options.overviewPromptId ?? null,
            detailPromptId: options.detailPromptId ?? null,
            scenarioId: options.scenarioId ?? null,
            toneId: options.toneId ?? null,
            language: options.language ?? null,
            length: options.length ?? null,
            enableWebSearch: options.enableWebSearch ?? false,
            attachedFileContent: options.attachedFileContent ?? null,
            attachedFileName: options.attachedFileName ?? null,
          }),
          signal: controller.signal,
          cache: 'no-store',
        })

        const payload = await consumeStreamV2(res, streamCallbacks, controller.signal)
        setIsStreaming(false)
        abortRef.current = null
        lastEventIdRef.current = null
        return payload
      } catch (err) {
        setIsStreaming(false)
        if (err instanceof DOMException && err.name === 'AbortError') {
          throw err
        }
        const message = err instanceof Error ? err.message : '发送失败'
        setError(message)
        throw err
      }
    },
    [conversationIdRef, callbacksRef, resetTurnState]
  )

  useEffect(() => {
    return () => {
      abortRef.current?.abort()
      abortRef.current = null
    }
  }, [])

  return { send, stop, isStreaming, error, toolState, pendingSources, pendingUsage }
}
