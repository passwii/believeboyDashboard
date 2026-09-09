import { isInsightEvent, type InsightErrorPayload, type InsightEvent } from './protocol'

export type ParsedSseEvent = {
  id: string | null
  event: string
  data: string
  retry?: number
}

/** Standard SSE line/event decoder. It accepts LF, CRLF, and CR line endings. */
export class SseParser {
  private buffer = ''
  private id: string | null = null
  private event = ''
  private dataLines: string[] = []
  private retry: number | undefined

  feed(input: string | Uint8Array, decoder?: TextDecoder): ParsedSseEvent[] {
    this.buffer +=
      typeof input === 'string'
        ? input
        : (decoder ?? new TextDecoder('utf-8')).decode(input, { stream: true })
    return this.readCompleteEvents()
  }

  finish(): ParsedSseEvent[] {
    const events = this.readCompleteEvents()
    if (this.buffer.length > 0) {
      const finalLine = this.buffer.endsWith('\r') ? this.buffer.slice(0, -1) : this.buffer
      this.processLine(finalLine)
      this.buffer = ''
    }
    const finalEvent = this.dispatchEvent()
    return finalEvent ? [...events, finalEvent] : events
  }

  private readCompleteEvents(): ParsedSseEvent[] {
    const events: ParsedSseEvent[] = []
    let lineEnd = findLineEnd(this.buffer)
    while (lineEnd) {
      const line = this.buffer.slice(0, lineEnd.index)
      this.buffer = this.buffer.slice(lineEnd.index + lineEnd.length)
      if (line === '') {
        const event = this.dispatchEvent()
        if (event) events.push(event)
      } else {
        this.processLine(line)
      }
      lineEnd = findLineEnd(this.buffer)
    }
    return events
  }

  private processLine(line: string): void {
    if (line.startsWith(':')) return

    const separator = line.indexOf(':')
    const field = separator === -1 ? line : line.slice(0, separator)
    let value = separator === -1 ? '' : line.slice(separator + 1)
    if (value.startsWith(' ')) value = value.slice(1)

    switch (field) {
      case 'id':
        if (!value.includes('\u0000')) this.id = value
        break
      case 'event':
        this.event = value
        break
      case 'data':
        this.dataLines.push(value)
        break
      case 'retry':
        if (/^\d+$/.test(value)) this.retry = Number(value)
        break
      default:
        break
    }
  }

  private dispatchEvent(): ParsedSseEvent | null {
    if (this.dataLines.length === 0) {
      this.id = null
      this.event = ''
      this.retry = undefined
      return null
    }

    const event: ParsedSseEvent = {
      id: this.id,
      event: this.event,
      data: this.dataLines.join('\n'),
      ...(this.retry === undefined ? {} : { retry: this.retry }),
    }
    this.id = null
    this.event = ''
    this.dataLines = []
    this.retry = undefined
    return event
  }
}

export class InsightHttpError extends Error {
  readonly name = 'InsightHttpError'
  readonly status: number
  readonly code: string
  readonly retryable: boolean
  readonly retryAfter: number | null
  readonly details: Record<string, unknown> | undefined

  constructor(
    status: number,
    message: string,
    options: {
      code?: string
      retryable?: boolean
      retryAfter?: number | null
      details?: Record<string, unknown>
    } = {}
  ) {
    super(message)
    this.status = status
    this.code = options.code ?? 'HTTP_ERROR'
    this.retryable = options.retryable ?? status >= 500
    this.retryAfter = options.retryAfter ?? null
    this.details = options.details
  }
}

export class InsightStreamEndedError extends Error {
  readonly name = 'InsightStreamEndedError'

  constructor(message = 'Insight stream ended before a terminal event') {
    super(message)
  }
}

export type ConsumeInsightStreamOptions = {
  signal?: AbortSignal
  onEvent?: (event: InsightEvent, metadata: { id: string | null }) => void
  onEventId?: (id: string) => void
  seenEventIds?: Set<string>
}

export type ConsumeInsightStreamResult = {
  lastEventId: string | null
  terminalEvent: InsightEvent | null
}

export async function consumeInsightStream(
  response: Response,
  options: ConsumeInsightStreamOptions = {}
): Promise<ConsumeInsightStreamResult> {
  if (!response.ok) throw await toInsightHttpError(response)
  if (!response.body) {
    throw new InsightStreamEndedError('Insight stream response has no body')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  const parser = new SseParser()
  const seenIds = options.seenEventIds ?? new Set<string>()
  let lastEventId: string | null = null
  let terminalEvent: InsightEvent | null = null

  const consume = (records: ParsedSseEvent[]) => {
    for (const record of records) {
      if (record.id !== null) {
        lastEventId = record.id
        options.onEventId?.(record.id)
      }
      if (record.id !== null && seenIds.has(record.id)) continue
      if (record.id !== null) seenIds.add(record.id)
      if (!record.data) continue

      let raw: unknown
      try {
        raw = JSON.parse(record.data)
      } catch {
        continue
      }
      if (!isInsightEvent(raw)) continue

      options.onEvent?.(raw, { id: record.id })
      if (raw.type === 'done' || raw.type === 'error') {
        terminalEvent = raw
        break
      }
    }
  }

  try {
    while (terminalEvent === null) {
      const { done, value } = await readWithAbort(reader, options.signal)
      if (done) break
      consume(parser.feed(decoder.decode(value, { stream: true })))
    }

    if (terminalEvent !== null) {
      await reader.cancel().catch(() => undefined)
      return { lastEventId, terminalEvent }
    }

    const trailingText = decoder.decode()
    if (trailingText) consume(parser.feed(trailingText))
    consume(parser.finish())
    if (terminalEvent === null) throw new InsightStreamEndedError()
    return { lastEventId, terminalEvent }
  } catch (error) {
    if (options.signal?.aborted || isAbortError(error)) throw abortError()
    throw error
  }
}

async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) return reader.read()
  if (signal.aborted) throw abortError()

  const abortResult = Promise.withResolvers<ReadableStreamReadResult<Uint8Array>>()
  const onAbort = () => {
    void reader.cancel().catch(() => undefined)
    abortResult.reject(abortError())
  }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([reader.read(), abortResult.promise])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

async function toInsightHttpError(response: Response): Promise<InsightHttpError> {
  const raw = await response.text().catch(() => '')
  let payload: unknown
  try {
    payload = raw ? JSON.parse(raw) : null
  } catch {
    payload = null
  }

  const detail = getStringField(payload, 'detail')
  const messageField = getStringField(payload, 'message')
  const message = detail ?? messageField ?? (raw.trim() || `Request failed (${response.status})`)
  const code = getStringField(payload, 'code') ?? 'HTTP_ERROR'
  const retryable = getBooleanField(payload, 'retryable') ?? response.status >= 500
  const retryAfter = getNumberField(payload, 'retry_after')
  const details = getRecordField(payload, 'details')
  return new InsightHttpError(response.status, message, { code, retryable, retryAfter, details })
}

function getField(value: unknown, field: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  for (const [key, candidate] of Object.entries(value)) {
    if (key === field) return candidate
  }
  return undefined
}

function getStringField(value: unknown, field: string): string | undefined {
  const candidate = getField(value, field)
  return typeof candidate === 'string' && candidate ? candidate : undefined
}

function getBooleanField(value: unknown, field: string): boolean | undefined {
  const candidate = getField(value, field)
  return typeof candidate === 'boolean' ? candidate : undefined
}

function getNumberField(value: unknown, field: string): number | undefined {
  const candidate = getField(value, field)
  return typeof candidate === 'number' ? candidate : undefined
}

function getRecordField(value: unknown, field: string): Record<string, unknown> | undefined {
  const candidate = getField(value, field)
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return undefined
  }

  const record: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(candidate)) record[key] = entry
  return record
}

function findLineEnd(value: string): { index: number; length: number } | null {
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (character === '\n') {
      return { index: index > 0 && value[index - 1] === '\r' ? index - 1 : index, length: index > 0 && value[index - 1] === '\r' ? 2 : 1 }
    }
    if (character === '\r') {
      if (index + 1 >= value.length) return null
      if (value[index + 1] !== '\n') return { index, length: 1 }
    }
  }
  return null
}

function isAbortError(value: unknown): boolean {
  return value instanceof DOMException && value.name === 'AbortError'
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError')
}

export type { InsightErrorPayload }
