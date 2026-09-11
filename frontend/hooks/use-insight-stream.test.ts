import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { InsightClient } from '@/lib/insight/client'
import type { InsightEvent, InsightRunRequest, InsightRunStartResponse } from '@/lib/insight/protocol'
import { useInsightStream } from './use-insight-stream'

const CANONICAL_REQUEST: InsightRunRequest = {
  schema_version: 1,
  role_id: 'schedule_report_summary',
  role_version: 1,
  project_id: 42,
  country: 'US',
  slots: { 'report.context': { slot_version: 1, frequency: 'weekly' } },
  idempotency_key: 'ledger-1:77',
}

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

type PushableSse = {
  response: Response
  push: (payload: string) => void
  close: () => void
}

function pushableSseResponse(): PushableSse {
  const encoder = new TextEncoder()
  const queue: Uint8Array[] = []
  let notify: (() => void) | null = null
  let finished = false

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue.shift()
      if (next) {
        controller.enqueue(next)
        return
      }
      if (finished) {
        controller.close()
        return
      }
      return new Promise<void>((resolve) => {
        notify = resolve
      })
    },
  })

  return {
    response: new Response(stream, {
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }),
    push(payload: string) {
      queue.push(encoder.encode(payload))
      const pending = notify
      notify = null
      pending?.()
    },
    close() {
      finished = true
      const pending = notify
      notify = null
      pending?.()
    },
  }
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
      completion = result.current.start(CANONICAL_REQUEST)
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
      await result.current.start(CANONICAL_REQUEST)
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
      void result.current.start(CANONICAL_REQUEST)
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
      void result.current.start(CANONICAL_REQUEST)
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
      await result.current.start(CANONICAL_REQUEST)
    })

    expect(result.current.status).toBe('failed')
    expect(result.current.error).toEqual(errorEvent.error)
  })

  it('coalesces a burst of deltas into one published draft update', async () => {
    const stream = pushableSseResponse()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ run_id: 'run-6', status: 'queued', attempt: 1 }))
      .mockResolvedValueOnce(stream.response)
    const client = new InsightClient({ fetch: fetchMock })
    const published: string[] = []
    const { result } = renderHook(() => {
      const state = useInsightStream({ client, batchWindowMs: 150 })
      published.push(state.partialDrafts.summary ?? '')
      return state
    })

    act(() => {
      void result.current.start(CANONICAL_REQUEST)
    })
    await waitFor(() => expect(result.current.status).toBe('live'))

    act(() => {
      for (let index = 0; index < 30; index += 1) {
        stream.push(
          event('content.delta', { id: `delta-${index}`, seq: index + 1, slot: 'summary', delta: 'a' })
        )
      }
    })
    await act(async () => {})

    // 30 条 delta 落在同一个批处理窗口内：窗口未到期前不发布，避免每个 token 一次渲染。
    expect(result.current.partialDrafts.summary).toBeUndefined()

    await waitFor(() => expect(result.current.partialDrafts.summary).toBe('a'.repeat(30)))
    expect(published.filter((value) => value.length > 0)).toEqual(['a'.repeat(30)])
  })

  it('publishes an authoritative content snapshot without waiting for the batch window', async () => {
    const stream = pushableSseResponse()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ run_id: 'run-7', status: 'queued', attempt: 1 }))
      .mockResolvedValueOnce(stream.response)
    const client = new InsightClient({ fetch: fetchMock })
    const { result } = renderHook(() => useInsightStream({ client, batchWindowMs: 5_000 }))

    act(() => {
      void result.current.start(CANONICAL_REQUEST)
    })
    await waitFor(() => expect(result.current.status).toBe('live'))

    await act(async () => {
      stream.push(event('content.delta', { id: 'delta-1', seq: 1, slot: 'summary', delta: 'partial ' }))
      stream.push(
        event('content.snapshot', {
          id: 'snap-1',
          seq: 2,
          slot: 'summary',
          content: 'authoritative text',
          outputs: { summary: 'authoritative text' },
        })
      )
    })

    // 批处理窗口设成 5s：此刻能拿到终稿说明权威内容绕过了窗口，没有被 delta 覆盖。
    expect(result.current.partialDrafts).toEqual({ summary: 'authoritative text' })
  })

  it('attaches to a live run by cursor instead of replaying the whole stream', async () => {
    const stream = pushableSseResponse()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          schema_version: 1,
          run_id: 'run-8',
          attempt: 1,
          status: 'generating',
          stage: 'generating',
          progress_percent: 60,
          outputs: { main: { content: '已生成的一段' } },
          resume: { latest_event_id: 'run-8:1:2', current_attempt: 1, history_available: true },
        })
      )
      .mockResolvedValueOnce(stream.response)
    const client = new InsightClient({ fetch: fetchMock })
    const { result } = renderHook(() => useInsightStream({ client }))

    await act(async () => {
      await result.current.attach('run-8')
    })
    await waitFor(() => expect(result.current.status).toBe('live'))

    // detail 的 outputs 已收敛成 Markdown 文本
    expect(result.current.drafts).toEqual({ main: '已生成的一段' })
    expect(result.current.runStatus).toBe('generating')
    expect(result.current.progress).toBe(60)
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ 'Last-Event-ID': 'run-8:1:2' }),
      })
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('attaches to a finished run without opening a stream', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        schema_version: 1,
        run_id: 'run-9',
        attempt: 1,
        status: 'completed',
        stage: 'finalizing',
        progress_percent: 100,
        outputs: { main: { content: '## 摘要\n\n- 结论' } },
        resume: { latest_event_id: 'run-9:1:7', current_attempt: 1, history_available: true },
      })
    )
    const client = new InsightClient({ fetch: fetchMock })
    const { result } = renderHook(() => useInsightStream({ client }))

    await act(async () => {
      await result.current.attach('run-9')
    })

    expect(result.current.status).toBe('completed')
    expect(result.current.runStatus).toBe('completed')
    expect(result.current.drafts).toEqual({ main: '## 摘要\n\n- 结论' })
    // 终态不再订阅，避免重复文本
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reports a cancelled terminal error as cancelled, not failed', async () => {
    const cancelledEvent: InsightEvent = {
      schema_version: 1,
      run_id: 'run-10',
      attempt: 1,
      seq: 3,
      type: 'error',
      status: 'cancelled',
      error: { code: 'CANCELLED', message: '已取消本次运行', retryable: false },
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ run_id: 'run-10', status: 'queued', attempt: 1 }))
      .mockResolvedValueOnce(
        sseResponse(`id: run-10:1:3\ndata: ${JSON.stringify(cancelledEvent)}\n\n`)
      )
    const client = new InsightClient({ fetch: fetchMock })
    const { result } = renderHook(() => useInsightStream({ client }))

    await act(async () => {
      await result.current.start(CANONICAL_REQUEST)
    })

    expect(result.current.status).toBe('cancelled')
    expect(result.current.runStatus).toBe('cancelled')
  })
})
