import { describe, expect, it, vi } from 'vitest'

import { InsightClient, InsightHttpError } from './client'
import type { InsightRunRequest } from './protocol'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const CANONICAL_REQUEST: InsightRunRequest = {
  schema_version: 1,
  role_id: 'schedule_report_summary',
  role_version: 1,
  project_id: 42,
  country: 'US',
  slots: { 'report.context': { slot_version: 1 } },
  idempotency_key: 'ledger-1:77',
  model_id: 'controlled-model',
}

describe('InsightClient', () => {
  it('uses only the Next proxy and omits backend secrets from start payloads', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ run_id: 'run-1', status: 'queued', attempt: 1 })
    )
    const client = new InsightClient({ fetch: fetchMock })

    await client.start(CANONICAL_REQUEST)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/backend/v1/insight/runs')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', Accept: 'application/json' })
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body).toEqual(CANONICAL_REQUEST)
    expect(String(init.body)).not.toContain('api_key')
    expect(String(init.body)).not.toContain('system_prompt')
    expect(String(init.body)).not.toContain('base_url')
  })

  it('covers detail, stream, cancel, and retry through the same proxy base', async () => {
    const streamResponse = new Response(null, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ run_id: 'run-1', status: 'queued' }))
      .mockResolvedValueOnce(jsonResponse({ run_id: 'run-1', status: 'live' }))
      .mockResolvedValueOnce(streamResponse)
      .mockResolvedValueOnce(jsonResponse({ run_id: 'run-1', status: 'cancelled' }))
      .mockResolvedValueOnce(jsonResponse({ run_id: 'run-1', status: 'queued', attempt: 2 }))
    const client = new InsightClient({ fetch: fetchMock })

    await client.start(CANONICAL_REQUEST)
    await client.detail('run-1')
    await client.stream('run-1', { lastEventId: 'entry-9' })
    await client.cancel('run-1')
    await client.retry('run-1')

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      '/api/backend/v1/insight/runs',
      '/api/backend/v1/insight/runs/run-1',
      '/api/backend/v1/insight/runs/run-1/stream',
      '/api/backend/v1/insight/runs/run-1/cancel',
      '/api/backend/v1/insight/runs/run-1/retry',
    ])
    const [, streamInit] = fetchMock.mock.calls[2] as [string, RequestInit]
    expect(streamInit.method).toBe('GET')
    expect(streamInit.headers).toEqual({
      Accept: 'text/event-stream',
      'Last-Event-ID': 'entry-9',
    })
  })

  it('reads the canonical nested FastAPI detail into a typed HTTP error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          detail: {
            code: 'RATE_LIMITED',
            message: '请求过于频繁',
            retryable: true,
            retry_after_seconds: 30,
          },
        },
        429
      )
    )
    const client = new InsightClient({ fetch: fetchMock })

    await expect(client.start(CANONICAL_REQUEST)).rejects.toEqual(
      expect.objectContaining({
        name: 'InsightHttpError',
        status: 429,
        code: 'RATE_LIMITED',
        message: '请求过于频繁',
        retryable: true,
        retryAfter: 30,
      })
    )
    expect(new InsightHttpError(503, 'temporary').retryable).toBe(true)
  })

  it('still reads a flat legacy error body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ detail: 'invalid role', code: 'ROLE_UNKNOWN' }, 422))
    const client = new InsightClient({ fetch: fetchMock })

    await expect(client.start(CANONICAL_REQUEST)).rejects.toEqual(
      expect.objectContaining({
        name: 'InsightHttpError',
        status: 422,
        code: 'ROLE_UNKNOWN',
        message: 'invalid role',
      })
    )
  })
})
