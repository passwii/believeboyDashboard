import {
  consumeInsightStream,
  InsightHttpError,
  type ConsumeInsightStreamOptions,
} from './sse'
import type {
  InsightRunDetail,
  InsightRunRequest,
  InsightRunStartResponse,
} from './protocol'

const DEFAULT_BASE_PATH = '/api/backend/v1/insight/runs'

type FetchLike = typeof fetch

type InsightClientOptions = {
  fetch?: FetchLike
  basePath?: string
}

type InsightRequestOptions = {
  signal?: AbortSignal
}

export class InsightClient {
  private readonly fetcher: FetchLike
  private readonly basePath: string

  constructor(options: InsightClientOptions = {}) {
    this.fetcher = options.fetch ?? fetch
    this.basePath = trimTrailingSlash(options.basePath ?? DEFAULT_BASE_PATH)
  }

  async start(
    payload: InsightRunRequest,
    options: InsightRequestOptions = {}
  ): Promise<InsightRunStartResponse> {
    return this.json<InsightRunStartResponse>('', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify(payload),
      signal: options.signal,
    })
  }

  async detail(runId: string, options: InsightRequestOptions = {}): Promise<InsightRunDetail> {
    return this.json<InsightRunDetail>(`/${encodeURIComponent(runId)}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: options.signal,
    })
  }

  async stream(
    runId: string,
    options: InsightRequestOptions & {
      lastEventId?: string | null
      onEvent?: ConsumeInsightStreamOptions['onEvent']
      onEventId?: ConsumeInsightStreamOptions['onEventId']
      seenEventIds?: Set<string>
    } = {}
  ): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'text/event-stream' }
    if (options.lastEventId) headers['Last-Event-ID'] = options.lastEventId
    const response = await this.fetcher(this.url(`/${encodeURIComponent(runId)}/stream`), {
      method: 'GET',
      headers,
      signal: options.signal,
      cache: 'no-store',
    })
    return response
  }

  async cancel(runId: string, options: InsightRequestOptions = {}): Promise<InsightRunDetail> {
    return this.json<InsightRunDetail>(`/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      signal: options.signal,
    })
  }

  async retry(runId: string, options: InsightRequestOptions = {}): Promise<InsightRunStartResponse> {
    return this.json<InsightRunStartResponse>(`/${encodeURIComponent(runId)}/retry`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      signal: options.signal,
    })
  }

  private async json<T>(suffix: string, init: RequestInit): Promise<T> {
    const response = await this.fetcher(this.url(suffix), { ...init, cache: 'no-store' })
    if (!response.ok) throw await toInsightHttpError(response)
    return (await response.json()) as T
  }

  private url(suffix: string): string {
    return `${this.basePath}${suffix}`
  }
}

function jsonHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json', Accept: 'application/json' }
}

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value
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

export { DEFAULT_BASE_PATH }
export { InsightHttpError }
export { consumeInsightStream }
