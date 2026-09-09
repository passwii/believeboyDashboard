import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { InsightClient } from '@/lib/insight/client'
import type { InsightEvent, InsightRunStartResponse } from '@/lib/insight/protocol'
import { useInsightStream } from './use-insight-stream'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function sseResponse(payload: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload))
      controller.close()
    },
  })
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  })
}

function event(type: string, fields: Record<string, unknown> = {}): string {
  return `id: ${fields.id ?? type}\ndata: ${JSON.stringify({
    schema_version: 1,
    run_id: 'run-1',
    attempt: 1,
    seq: fields.seq ?? 1,
    type,
    ...fields,
  })}\n\n`
}

describe('useInsightStream', () => {
  it('owns one stream, resumes with Last-Event-ID, deduplicates ids, and preserves slot drafts', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ run_id: 'run-1', status: 'queued', attempt: 1 } satisfies InsightRunStartResponse))
      .mockResolvedValueOnce(
        sseResponse(
          event('status', { id: 'entry-0', status: 'live', seq: 0 }) +
            event('content.delta', { id: 'entry-1', seq: 1, slot: 'summary', delta: 'hello ' }) +
            event('content.delta', { id: 'entry-1', seq: 1, slot: 'summary', delta: 'duplicate' })
        )
      )
      .mockResolvedValueOnce(
        sseResponse(
          event('content.delta', { id: 'entry-2', seq: 2, slot: 'summary', delta: 'world' }) +
            event('done', { id: 'entry-3', seq: 3, outputs: { summary: 'hello world' } })
        )
      )
    const statuses: string[] = []
    const client = new InsightClient({ fetch: fetchMock })
    const { result } = renderHook(() =>
      useInsightStream({
        client,
        reconnectDelayMs: 0,
        maxReconnectAttempts: 2,
        onStatusChange: (status) => statuses.push(status),
      })
    )

    let completion: Promise<unknown> | undefined
    await act(async () => {
      completion = result.current.start({ capability: 'reporting', role: 'schedule_report_summary.v1' })
      await completion
    })

    await waitFor(() => expect(result.current.status).toBe('completed'))
    expect(result.current.runId).toBe('run-1')
    expect(result.current.drafts).toEqual({ summary: 'hello world' })
    expect(result.current.partialDrafts).toEqual({ summary: 'hello world' })
    expect(result.current.lastEventId).toBe('entry-3')
    expect(statuses).toContain('reconnecting')
    expect(fetchMock.mock.calls[2]?.[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ 'Last-Event-ID': 'entry-1' }),
      })
    )
  })

  it('uses a snapshot as the fallback draft when content deltas are absent', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ run_id: 'run-2', status: 'queued', attempt: 1 }))
      .mockResolvedValueOnce(
        sseResponse(
          event('snapshot', {
            id: 'entry-1',
            snapshot: { outputs: { summary: 'recovered draft' } },
            seq: 1,
          }) + event('done', { id: 'entry-2', outputs: { summary: 'final answer' }, seq: 2 })
        )
      )
    const client = new InsightClient({ fetch: fetchMock })
    const { result } = renderHook(() => useInsightStream({ client }))

    await act(async () => {
      await result.current.start({ capability: 'reporting', role: 'schedule_report_summary.v1' })
    })

    expect(result.current.snapshot).toEqual({ outputs: { summary: 'recovered draft' } })
    expect(result.current.drafts).toEqual({ summary: 'final answer' })
    expect(result.current.backgroundMessage).toBeNull()
  })

  it('marks a cancelled stream without reconnecting and calls the cancel endpoint', async () => {
    const { promise: pendingRead, resolve: release } = Promise.withResolvers<void>()
    const pendingStream = new ReadableStream<Uint8Array>({
      pull() {
        return pendingRead
      },
      cancel() {
        release()
      },
    })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ run_id: 'run-3', status: 'queued', attempt: 1 }))
      .mockResolvedValueOnce(new Response(pendingStream, { headers: { 'content-type': 'text/event-stream' } }))
      .mockResolvedValueOnce(jsonResponse({ run_id: 'run-3', status: 'cancelled' }))
    const client = new InsightClient({ fetch: fetchMock })
    const { result } = renderHook(() => useInsightStream({ client, reconnectDelayMs: 0 }))

    act(() => {
      void result.current.start({ capability: 'reporting', role: 'schedule_report_summary.v1' })
    })
    await waitFor(() => expect(result.current.status).toBe('live'))

    await act(async () => {
      await result.current.cancel()
    })

    expect(result.current.status).toBe('cancelled')
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/backend/v1/insight/runs/run-3/cancel')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('exposes a background continuation message when detached', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ run_id: 'run-4', status: 'queued', attempt: 1 }))
      .mockResolvedValueOnce(sseResponse(event('status', { id: 'entry-1', status: 'live' })))
    const client = new InsightClient({ fetch: fetchMock })
    const { result } = renderHook(() => useInsightStream({ client }))

    act(() => {
      void result.current.start({ capability: 'reporting', role: 'schedule_report_summary.v1' })
    })
    await waitFor(() => expect(result.current.status).toBe('reconnecting'))

    act(() => {
      result.current.detach()
    })

    expect(result.current.backgroundMessage).toBe('已转入后台继续生成')
    expect(result.current.isDetached).toBe(true)
  })

  it('forwards typed errors to failed state', async () => {
    const errorEvent: InsightEvent = {
      schema_version: 1,
      run_id: 'run-5',
      attempt: 1,
      seq: 1,
      type: 'error',
      error: { code: 'MODEL_UNAVAILABLE', message: 'model unavailable', retryable: false },
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ run_id: 'run-5', status: 'queued', attempt: 1 }))
      .mockResolvedValueOnce(sseResponse(`id: entry-1\ndata: ${JSON.stringify(errorEvent)}\n\n`))
    const client = new InsightClient({ fetch: fetchMock })
    const { result } = renderHook(() => useInsightStream({ client }))

    await act(async () => {
      await result.current.start({ capability: 'reporting', role: 'schedule_report_summary.v1' })
    })

    expect(result.current.status).toBe('failed')
    expect(result.current.error).toEqual(errorEvent.error)
  })
})
