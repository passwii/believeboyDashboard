/**
 * AI Chat V2 stream consumer — parses Anthropic-style SSE events.
 *
 * The V2 backend (`ai_chat_v2.py`) emits standard SSE (text/event-stream):
 *   id: <redis-entry-id>
 *   data: {"type":"message_start",...}
 *
 * Event types (Anthropic Messages protocol + project extensions):
 *   - message_start          → fired once at the start of a turn
 *   - content_block_start    → new content block (text / thinking / tool_use / tool_result)
 *   - content_block_delta    → incremental delta (text_delta / thinking_delta / input_json_delta)
 *   - content_block_stop     → content block finished
 *   - message_delta          → usage + stop_reason
 *   - message_stop           → terminal (stream complete)
 *   - error                  → terminal (typed error code)
 *   - ping                   → keepalive (ignored)
 *   - done                   → project extension: persisted message data (compat with V1 frontend)
 *
 * The consumer tracks `Last-Event-ID` for resume/reconnect support.
 */

import type { ServerChatMessage, SearchSource, SearchTimeRange } from './ai-chat'
import type { StreamCallbacks, StreamDonePayload, StreamUsage, StreamToolState } from './ai-chat-stream'

// ── V2 Protocol Types ──

export type V2ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error: boolean }

export type V2Delta =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'input_json_delta'; partial_json: string }

export type V2Usage = {
  input_tokens: number
  output_tokens: number
  total_tokens: number
}

export type V2ErrorCode =
  | 'cancelled'
  | 'timeout'
  | 'rate_limit'
  | 'overloaded'
  | 'auth'
  | 'invalid_request'
  | 'not_found'
  | 'internal'
  | 'model'
  | 'context_length'
  | 'unknown'

export type V2ProtocolEvent =
  | { type: 'message_start'; message_id: string; model: string; created_at: number }
  | { type: 'content_block_start'; index: number; content_block: V2ContentBlock }
  | { type: 'content_block_delta'; index: number; delta: V2Delta }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; usage?: V2Usage; stop_reason?: string }
  | { type: 'message_stop' }
  | { type: 'error'; error: { code: V2ErrorCode; message: string } }
  | { type: 'ping' }
  // Project extension (not Anthropic standard)
  | { type: 'done'; user_message: ServerChatMessage; assistant_message: ServerChatMessage;
      conversation_title: string | null; token_usage: StreamUsage | null;
      conversation_token_usage?: StreamUsage | null; duration_ms: number | null;
      title_regenerated: boolean }

// ── SSE Parser ──

type ParsedSSEEvent = {
  id: string | null
  data: string
}

/**
 * Parse a chunk of SSE text into individual events.
 * Returns parsed events + remaining buffer (partial event).
 */
function parseSSEChunk(buffer: string): { events: ParsedSSEEvent[]; remaining: string } {
  const events: ParsedSSEEvent[] = []
  // SSE events are delimited by double newlines
  const parts = buffer.split('\n\n')
  // Last part might be incomplete (no trailing \n\n yet)
  const remaining = parts.pop() ?? ''

  for (const part of parts) {
    if (!part.trim()) continue
    let id: string | null = null
    let data = ''
    for (const line of part.split('\n')) {
      if (line.startsWith('id: ')) {
        id = line.slice(4).trim()
      } else if (line.startsWith('data: ')) {
        data = line.slice(6)
      } else if (line.startsWith('data:')) {
        data = line.slice(5)
      }
      // Ignore other fields (event:, retry:, comments starting with :)
    }
    if (data) {
      events.push({ id, data })
    }
  }

  return { events, remaining }
}

// ── Event Dispatch ──

function normalizeV2Usage(usage: V2Usage | undefined): StreamUsage | null {
  if (!usage) return null
  return {
    prompt_tokens: usage.input_tokens ?? 0,
    completion_tokens: usage.output_tokens ?? 0,
    total_tokens: usage.total_tokens ?? 0,
  }
}

/**
 * Dispatch a V2 protocol event to the V1-compatible callbacks.
 * Returns StreamDonePayload on terminal `done` event, null otherwise.
 * Throws on `error` event.
 */
function dispatchV2Event(
  event: V2ProtocolEvent,
  callbacks: StreamCallbacks,
  toolState: StreamToolState,
): StreamDonePayload | null {
  switch (event.type) {
    case 'message_start':
      callbacks.onStart?.()
      return null

    case 'content_block_start': {
      const block = event.content_block
      if (block.type === 'tool_use') {
        toolState.toolCallsCount += 1
        toolState.searching = true
        toolState.done = false
        callbacks.onToolState?.({ ...toolState })
      }
      return null
    }

    case 'content_block_delta': {
      const delta = event.delta
      if (delta.type === 'text_delta' && delta.text) {
        callbacks.onChunk?.(delta.text)
      } else if (delta.type === 'thinking_delta' && delta.text) {
        callbacks.onThinking?.(delta.text)
      }
      // input_json_delta: accumulated internally, not surfaced to UI in P1
      return null
    }

    case 'content_block_stop':
      // If we were searching (tool_use block ended), mark done
      if (toolState.searching) {
        toolState.searching = false
        toolState.done = true
        callbacks.onToolState?.({ ...toolState })
      }
      return null

    case 'message_delta': {
      const usage = normalizeV2Usage(event.usage)
      if (usage) callbacks.onUsage?.(usage)
      return null
    }

    case 'message_stop':
      // Terminal but no payload — the `done` event (project extension) carries it.
      // If no `done` event follows (e.g. resume path), treat as success with null payload.
      return null

    case 'error': {
      const msg = event.error.message || '流式错误'
      callbacks.onError?.(msg)
      throw new Error(msg)
    }

    case 'ping':
      return null

    case 'done': {
      // Project extension: persisted message data
      const payload: StreamDonePayload = {
        userMessage: event.user_message,
        assistantMessage: event.assistant_message,
        conversationTitle: event.conversation_title ?? null,
        tokenUsage: event.token_usage ?? null,
        conversationTokenUsage: event.conversation_token_usage ?? null,
        durationMs: typeof event.duration_ms === 'number' ? event.duration_ms : null,
        titleRegenerated: Boolean(event.title_regenerated),
      }
      callbacks.onDone?.(payload)
      return payload
    }

    default:
      // Unknown event — ignore for forward compatibility
      return null
  }
}

// ── Main Consumer ──

/**
 * Consume a V2 SSE stream and dispatch events to V1-compatible callbacks.
 * Resolves on `done` (success) and rejects on `error` / network failure / abort.
 *
 * Tracks Last-Event-ID for resume support.
 */
export async function consumeStreamV2(
  response: Response,
  callbacks: StreamCallbacks,
  signal: AbortSignal,
): Promise<StreamDonePayload> {
  if (!response.ok) {
    const raw = await response.text().catch(() => '')
    let msg = `请求失败 (${response.status})`
    try {
      const parsed = JSON.parse(raw) as { detail?: string; message?: string }
      msg = parsed.detail || parsed.message || msg
    } catch {
      if (raw.trim()) msg = raw.trim()
    }
    callbacks.onError?.(msg)
    throw new Error(msg)
  }

  if (!response.body) {
    const msg = '流式响应无 body'
    callbacks.onError?.(msg)
    throw new Error(msg)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  const toolState: StreamToolState = { toolCallsCount: 0, searching: false, done: false }

  let buffer = ''
  let lastEventId: string | null = null
  let donePayload: StreamDonePayload | null = null
  let sawMessageStop = false

  try {
    while (true) {
      if (signal.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError')
      }
      const { value, done } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const { events, remaining } = parseSSEChunk(buffer)
      buffer = remaining

      for (const sseEvent of events) {
        if (sseEvent.id) {
          lastEventId = sseEvent.id
        }

        let parsed: V2ProtocolEvent
        try {
          parsed = JSON.parse(sseEvent.data) as V2ProtocolEvent
        } catch {
          // Malformed JSON — skip
          continue
        }

        const payload = dispatchV2Event(parsed, callbacks, toolState)
        if (payload) {
          donePayload = payload
          // Don't break yet — wait for message_stop to confirm stream end
        }
        if (parsed.type === 'message_stop') {
          sawMessageStop = true
          // If we have done payload, we're finished
          if (donePayload) {
            try { await reader.cancel() } catch { /* ignore */ }
            return donePayload
          }
        }
      }
    }

    // Stream ended
    if (donePayload) {
      return donePayload
    }

    // No done event received — stream ended prematurely
    if (sawMessageStop) {
      // message_stop without done — acceptable in resume path
      // Return a minimal payload
      const msg = '流式响应缺少 done 事件'
      callbacks.onError?.(msg)
      throw new Error(msg)
    }

    const msg = '流式响应提前结束'
    callbacks.onError?.(msg)
    throw new Error(msg)
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err
    }
    if (err instanceof Error) {
      throw err
    }
    throw new Error(String(err))
  }
}


