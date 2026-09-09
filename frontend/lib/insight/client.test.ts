import { describe, expect, it, vi } from 'vitest'

import { InsightClient, InsightHttpError } from './client'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('InsightClient', () => {
  it('uses only the Next proxy and omits backend secrets from start payloads', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ run_id: 'run-1', status: 'queued', attempt: 1 })
    )
    const client = new InsightClient({ fetch: fetchMock })

    await client.start({
      capability: 'reporting',
      role: 'schedule_report_summary.v1',
      scope: { project_id: 42, country: 'US' },
      slots: { 'report.period': { value: '2026-08' } },
      model: 'controlled-model',
      idempotency_key: 'request-1',
    })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/backend/v1/insight/runs')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', Accept: 'application/json' })
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

    await client.start({ capability: 'reporting', role: 'schedule_report_summary.v1' })
    await client.detail('run-1')
    await client.stream('run-1', { lastEventId: 'entry-9' })
    await client.cancel('run-1')
    await client.retry('run-1')

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
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

  it('turns non-2xx JSON and text responses into typed HTTP errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ detail: 'invalid role', code: 'ROLE_UNKNOWN' }, 422))
    const client = new InsightClient({ fetch: fetchMock })

    await expect(client.start({ capability: 'reporting', role: 'unknown' })).rejects.toEqual(
      expect.objectContaining({
        name: 'InsightHttpError',
        status: 422,
        code: 'ROLE_UNKNOWN',
        message: 'invalid role',
      })
    )
    expect(new InsightHttpError(503, 'temporary').retryable).toBe(true)
  })
})
