/**
 * useChatStream — drives a single backend streaming turn.
 *
 * Replaces `useSimulatedStream`. Instead of typing out a hard-coded reply,
 * it POSTs to `/api/ai-chat/conversations/:id/messages/stream` and pipes the
 * ndjson body through `consumeStream`. The hook exposes:
 *
 *   - `send(content, options)`  — fire-and-forget POST that resolves on `done`
 *                                  and rejects on `error` / abort / network
 *   - `stop()`                  — `AbortController.abort()`. Stops the local
 *                                  UI from receiving chunks; the backend is
 *                                  not signaled (it has no awareness of
 *                                  client abort yet — see parent issue).
 *   - `isStreaming`             — convenience flag for callers.
 *   - `error`                   — last error message, cleared on next `send`.
 *
 * The hook owns the AbortController; mounting a new `send` cancels any
 * previously in-flight one. The caller passes a stable `callbacks` object
 * (or refs) — the stream's event flow is forwarded there.
 *
 * `callbacks.onUserMessageId` / `onAssistantId` are exposed so the parent
 * can swap optimistic placeholder ids for the real persisted ones once
 * the `done` event arrives.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { consumeStream, type StreamCallbacks, type StreamDonePayload, type StreamUsage } from '@/lib/api/ai-chat-stream'
import type { SearchSource } from '@/lib/api/ai-chat'

export type ChatStreamOptions = {
  model?: string
  reasoningEffort?: string | null
  regenerate?: boolean
  targetMessageId?: number
  overviewPromptId?: string | null
  detailPromptId?: string | null
  enableWebSearch?: boolean
  attachedFileContent?: string | null
  attachedFileName?: string | null
}

export type UseChatStreamCallbacks = StreamCallbacks & {
  /** Persisted id of the user message once the backend commits it. */
  onUserMessageId?: (id: number) => void
  /** Persisted id of the assistant message once the backend commits it. */
  onAssistantId?: (id: number) => void
  /** When the server regenerates a conversation title — fired in the `done` event. */
  onTitleUpdate?: (title: string) => void
}

export type UseChatStreamResult = {
  send: (content: string, options?: ChatStreamOptions) => Promise<StreamDonePayload>
  stop: () => void
  isStreaming: boolean
  error: string | null
  /** Latest tool state (e.g. "searching…" badge in the UI). */
  toolState: { toolCallsCount: number; searching: boolean; done: boolean } | null
  /** Accumulated sources for the in-flight turn. */
  pendingSources: SearchSource[]
  /** Accumulated usage for the in-flight turn. */
  pendingUsage: StreamUsage | null
}

export function useChatStream(
  conversationId: number,
  callbacksRef: React.MutableRefObject<UseChatStreamCallbacks>,
): UseChatStreamResult {
  const abortRef = useRef<AbortController | null>(null)
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toolState, setToolState] = useState<UseChatStreamResult['toolState']>(null)
  const [pendingSources, setPendingSources] = useState<SearchSource[]>([])
  const [pendingUsage, setPendingUsage] = useState<StreamUsage | null>(null)

  // Reset accumulated per-turn state when a new turn starts / aborts.
  const resetTurnState = useCallback(() => {
    setToolState(null)
    setPendingSources([])
    setPendingUsage(null)
  }, [])

  const stop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setIsStreaming(false)
  }, [])

  const send = useCallback(
    async (content: string, options: ChatStreamOptions = {}): Promise<StreamDonePayload> => {
      // Cancel any in-flight request before starting a new one.
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      setIsStreaming(true)
      setError(null)
      resetTurnState()

      const cb = (name: keyof UseChatStreamCallbacks) => (...args: unknown[]) => {
        const fn = callbacksRef.current[name] as ((...a: unknown[]) => void) | undefined
        fn?.(...args)
      }

      const streamCallbacks: StreamCallbacks = {
        onStart: cb('onStart') as () => void,
        onChunk: cb('onChunk') as (delta: string) => void,
        onThinking: cb('onThinking') as (delta: string) => void,
        onSources: (sources, meta) => {
          setPendingSources(sources)
          // [BEL-81.B] 把 time_range / query 一并透传给父组件
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
          // Persisted ids are surfaced so the parent can reconcile optimistic
          // placeholders with the real server ids (needed for retry/regen).
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
        const res = await fetch(
          `/api/ai-chat/conversations/${conversationId}/messages/stream`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
            body: JSON.stringify({
              content,
              model: options.model,
              reasoningEffort: options.reasoningEffort ?? null,
              regenerate: options.regenerate ?? false,
              // Route handler reads snake_case; this is the contract.
              target_message_id: options.targetMessageId,
              overviewPromptId: options.overviewPromptId ?? null,
              detailPromptId: options.detailPromptId ?? null,
              enableWebSearch: options.enableWebSearch ?? false,
              attachedFileContent: options.attachedFileContent ?? null,
              attachedFileName: options.attachedFileName ?? null,
            }),
            signal: controller.signal,
            cache: 'no-store',
          },
        )

        const payload = await consumeStream(res, streamCallbacks, controller.signal)
        setIsStreaming(false)
        abortRef.current = null
        return payload
      } catch (err) {
        setIsStreaming(false)
        // For abort, the parent called stop() — keep the existing error in place
        // (do not clobber with an abort error). Re-throw so callers can branch.
        if (err instanceof DOMException && err.name === 'AbortError') {
          throw err
        }
        const message = err instanceof Error ? err.message : '发送失败'
        setError(message)
        throw err
      }
    },
    [conversationId, callbacksRef, resetTurnState],
  )

  // Make sure to abort on unmount — otherwise React will warn about state
  // updates on an unmounted component when the stream resolves later.
  useEffect(() => {
    return () => {
      abortRef.current?.abort()
      abortRef.current = null
    }
  }, [])

  return { send, stop, isStreaming, error, toolState, pendingSources, pendingUsage }
}
