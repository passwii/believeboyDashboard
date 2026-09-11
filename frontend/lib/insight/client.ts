import {
  consumeInsightStream,
  InsightHttpError,
  toInsightHttpError,
  type ConsumeInsightStreamOptions,
} from './sse'
import type {
  InsightRunActionResponse,
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

  async cancel(
    runId: string,
    options: InsightRequestOptions = {}
  ): Promise<InsightRunActionResponse> {
    return this.json<InsightRunActionResponse>(`/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      signal: options.signal,
    })
  }

  async retry(
    runId: string,
    options: InsightRequestOptions = {}
  ): Promise<InsightRunActionResponse> {
    return this.json<InsightRunActionResponse>(`/${encodeURIComponent(runId)}/retry`, {
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

export { DEFAULT_BASE_PATH }
export { InsightHttpError }
export { consumeInsightStream }
