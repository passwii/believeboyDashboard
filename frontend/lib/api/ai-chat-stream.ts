/**
 * AI Chat stream consumer — parses backend ndjson events.
 *
 * The backend (`app/services/ai/stream_utils.py`) encodes each event as a
 * single JSON object followed by `\n` (Content-Type: application/x-ndjson).
 * This is the modern equivalent of SSE — the parser is just a line splitter.
 *
 * Event types (from `build_stream_*` in stream_utils.py):
 *   - start                  → fired once at the start of a turn
 *   - chunk                  → assistant text delta
 *   - thinking_chunk         → model "thinking" delta (collapsible)
 *   - tool_calls / tool_searching / tool_done → web search tool state
 *   - sources                → search source cards
 *   - usage                  → token usage (prompt / completion / total)
 *   - done                   → terminal; carries persisted user + assistant messages
 *   - error                  → terminal; carries the error message
 *
 * The consumer does NOT inspect Content-Type. The backend always sends
 * `application/x-ndjson` for this path, but reading line-by-line works for
 * any newline-delimited payload — the parser stays robust if a proxy in the
 * chain rewrites the type.
 */

import type { ServerChatMessage, SearchSource, SearchTimeRange } from './ai-chat'

export type StreamUsage = {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

export type StreamToolState = {
  toolCallsCount: number
  searching: boolean
  done: boolean
}

export type StreamDonePayload = {
  userMessage: ServerChatMessage
  assistantMessage: ServerChatMessage
  conversationTitle: string | null
  tokenUsage: StreamUsage | null
  /**
   * Conversation-level cumulative token usage (prompt / completion / total).
   * The backend emits this in the `done` event; we surface it for sidebar
   * totals and other future UI. Optional so the consumer can ignore it
   * without an extra type guard.
   */
  conversationTokenUsage?: StreamUsage | null
  durationMs: number | null
  titleRegenerated: boolean
}

export type StreamCallbacks = {
  onStart?: () => void
  onChunk?: (delta: string) => void
  onThinking?: (delta: string) => void
  onSources?: (sources: SearchSource[], meta?: { timeRange?: SearchTimeRange; query?: string }) => void
  onUsage?: (usage: StreamUsage) => void
  onToolState?: (state: StreamToolState) => void
  onDone?: (payload: StreamDonePayload) => void
  onError?: (message: string) => void
}

type RawEvent = {
  type?: string
  delta?: string
  sources?: SearchSource[]
  /** [BEL-81.B] 联网搜索时间范围标签，可选 */
  time_range?: SearchTimeRange
  /** [BEL-81.B] 实际搜索词，可选 */
  query?: string
  usage?: StreamUsage
  tool_calls?: unknown[]
  message?: string
  // 'done' payload
  user_message?: ServerChatMessage
  assistant_message?: ServerChatMessage
  conversation_title?: string | null
  token_usage?: StreamUsage | null
  conversation_token_usage?: StreamUsage | null
  duration_ms?: number | null
  title_regenerated?: boolean
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function normalizeUsage(value: unknown): StreamUsage | null {
  if (!isRecord(value)) return null
  const prompt = Number(value.prompt_tokens ?? 0) || 0
  const completion = Number(value.completion_tokens ?? 0) || 0
  const total = Number(value.total_tokens ?? 0) || 0
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total }
}

/**
 * Consume a streaming Response body and dispatch events to the supplied
 * callbacks. Resolves on `done` (success) and rejects on `error` / network
 * failure / abort.
 *
 * Designed to be driven by `useChatStream`. We accept the raw `Response`
 * (not an EventSource) because the backend's ndjson format is not standard
 * SSE — `fetch` + a TextDecoder is the cleanest path.
 */
export async function consumeStream(
  response: Response,
  callbacks: StreamCallbacks,
  signal: AbortSignal,
): Promise<StreamDonePayload> {
  if (!response.ok) {
    // The error body may be JSON or plain text. Read once and try to extract
    // a `message` / `detail` field.
    const raw = await response.text().catch(() => '')
    let msg = `请求失败 (${response.status})`
    try {
      const parsed = JSON.parse(raw) as { detail?: string; message?: string }
      msg = parsed.detail || parsed.message || msg
    } catch {
      if (raw.trim()) msg = raw.trim()
    }
    const err = new Error(msg)
    callbacks.onError?.(msg)
    throw err
  }

  if (!response.body) {
    const msg = '流式响应无 body'
    callbacks.onError?.(msg)
    throw new Error(msg)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')

  // Track tool state across the stream — `tool_searching` and `tool_done` are
  // marker events without state, so we maintain a small accumulator and emit
  // a snapshot whenever one of them fires.
  const toolState: StreamToolState = { toolCallsCount: 0, searching: false, done: false }

  let buffer = ''

  const flushLine = (line: string): RawEvent | null => {
    const trimmed = line.trim()
    if (!trimmed) return null
    try {
      return JSON.parse(trimmed) as RawEvent
    } catch {
      // Malformed line — skip. The backend should never emit these, but we
      // don't want a single bad frame to kill the whole stream.
      return null
    }
  }

  try {
    while (true) {
      if (signal.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError')
      }
      const { value, done } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // Split on newlines and keep the tail (partial line) in the buffer.
      let newlineIdx = buffer.indexOf('\n')
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx)
        buffer = buffer.slice(newlineIdx + 1)
        const event = flushLine(line)
        if (event) {
          const payload = dispatchEvent(event, callbacks, toolState)
          if (payload) {
            // Terminal `done` — close out
            try {
              await reader.cancel()
            } catch {
              // Ignore — the body is already done if we got a `done` event.
            }
            return payload
          }
        }
        newlineIdx = buffer.indexOf('\n')
      }
    }

    // Stream closed without `done` — treat as error so the caller surfaces it.
    const msg = '流式响应提前结束'
    callbacks.onError?.(msg)
    throw new Error(msg)
  } catch (err) {
    if (isAbortError(err)) {
      // Re-throw — caller distinguishes "user stopped" from real errors.
      throw err
    }
    if (err instanceof Error) {
      // Already enriched with a message above? Pass through.
      throw err
    }
    throw new Error(String(err))
  }
}

function dispatchEvent(
  event: RawEvent,
  callbacks: StreamCallbacks,
  toolState: StreamToolState,
): StreamDonePayload | null {
  const type = event.type
  switch (type) {
    case 'start':
      callbacks.onStart?.()
      return null
    case 'chunk':
      if (typeof event.delta === 'string' && event.delta) {
        callbacks.onChunk?.(event.delta)
      }
      return null
    case 'thinking_chunk':
      if (typeof event.delta === 'string' && event.delta) {
        callbacks.onThinking?.(event.delta)
      }
      return null
    case 'sources': {
      if (Array.isArray(event.sources)) {
        // [BEL-81.B] 把后端透传的 time_range / query 一并回调
        const meta: { timeRange?: SearchTimeRange; query?: string } = {}
        if (event.time_range) meta.timeRange = event.time_range
        if (event.query) meta.query = event.query
        callbacks.onSources?.(event.sources as SearchSource[], meta)
      }
      return null
    }
    case 'usage': {
      const usage = normalizeUsage(event.usage)
      if (usage) callbacks.onUsage?.(usage)
      return null
    }
    case 'tool_calls':
      toolState.toolCallsCount += 1
      callbacks.onToolState?.({ ...toolState })
      return null
    case 'tool_searching':
      toolState.searching = true
      toolState.done = false
      callbacks.onToolState?.({ ...toolState })
      return null
    case 'tool_done':
      toolState.searching = false
      toolState.done = true
      callbacks.onToolState?.({ ...toolState })
      return null
    case 'done': {
      const userMessage = event.user_message
      const assistantMessage = event.assistant_message
      if (!userMessage || !assistantMessage) {
        const msg = 'done 事件缺少 user_message / assistant_message'
        callbacks.onError?.(msg)
        throw new Error(msg)
      }
      const payload: StreamDonePayload = {
        userMessage,
        assistantMessage,
        conversationTitle: event.conversation_title ?? null,
        tokenUsage: normalizeUsage(event.token_usage),
        conversationTokenUsage: normalizeUsage(event.conversation_token_usage),
        durationMs: typeof event.duration_ms === 'number' ? event.duration_ms : null,
        titleRegenerated: Boolean(event.title_regenerated),
      }
      callbacks.onDone?.(payload)
      return payload
    }
    case 'error': {
      const msg = typeof event.message === 'string' && event.message ? event.message : '流式错误'
      callbacks.onError?.(msg)
      throw new Error(msg)
    }
    default:
      // Unknown event — ignore. The backend is the source of truth; we should
      // not break the stream when it adds a new event type.
      return null
  }
}
