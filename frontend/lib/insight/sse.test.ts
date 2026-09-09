import { describe, expect, it, vi } from 'vitest'

import {
  InsightStreamEndedError,
  consumeInsightStream,
  SseParser,
} from './sse'

function responseFromChunks(chunks: Uint8Array[], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  return new Response(stream, {
    status,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  })
}

function utf8Chunks(value: string, splitAt: number[] = []): Uint8Array[] {
  const bytes = new TextEncoder().encode(value)
  const boundaries = [0, ...splitAt, bytes.byteLength]
  return boundaries.slice(0, -1).map((start, index) => bytes.slice(start, boundaries[index + 1]))
}

describe('SseParser', () => {
  it('handles UTF-8 boundaries, CRLF, ids, multiline data, and unknown fields', () => {
    const parser = new SseParser()
    const source = 'id: 7\r\nevent: future\r\ndata: {"text":"你\r\ndata: 好"}\r\nretry: 1000\r\n\r\n'
    const bytes = new TextEncoder().encode(source)
    const decoder = new TextDecoder('utf-8')
    const first = parser.feed(bytes.slice(0, 22), decoder)
    const second = parser.feed(bytes.slice(22), decoder)

    expect(first).toEqual([])
    expect(second).toEqual([
      {
        id: '7',
        event: 'future',
        data: '{"text":"你\n好"}',
        retry: 1000,
      },
    ])
  })

  it('keeps separate events in one chunk and flushes an unterminated final event', () => {
    const parser = new SseParser()
    expect(parser.feed('id: a\ndata: one\n\nid: b\ndata: two\n')).toEqual([
      { id: 'a', event: '', data: 'one' },
    ])
    expect(parser.finish()).toEqual([{ id: 'b', event: '', data: 'two' }])
  })
})

describe('consumeInsightStream', () => {
  it('decodes UTF-8, ignores malformed JSON and unknown events, and deduplicates ids', async () => {
    const onEvent = vi.fn()
    const response = responseFromChunks(
      utf8Chunks(
        [
          'id: 1\r\ndata: {"type":"content.delta","run_id":"run-1","schema_version":1,"attempt":1,"seq":1,"slot":"summary","delta":"你"}\r\n\r\n',
          'id: 1\ndata: {"type":"content.delta","run_id":"run-1","schema_version":1,"attempt":1,"seq":1,"slot":"summary","delta":"重复"}\n\n',
          'id: 2\ndata: not-json\n\n',
          'event: future\ndata: {"type":"future","value":true}\n\n',
          'id: 3\ndata: {"type":"done","run_id":"run-1","schema_version":1,"attempt":1,"seq":3,"outputs":{"summary":"你"}}\n\n',
        ].join(''),
        [17, 18, 19]
      )
    )

    const result = await consumeInsightStream(response, { onEvent })

    expect(result.lastEventId).toBe('3')
    expect(result.terminalEvent?.type).toBe('done')
    expect(onEvent).toHaveBeenCalledTimes(3)
    expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual([
      'content.delta',
      'future',
      'done',
    ])
  })

  it('rejects a successful response that closes before a terminal event', async () => {
    const response = responseFromChunks(utf8Chunks('id: 1\ndata: {"type":"ping"}\n\n'))

    await expect(consumeInsightStream(response)).rejects.toBeInstanceOf(InsightStreamEndedError)
  })

  it('surfaces HTTP errors without attempting to parse them as SSE', async () => {
    const response = new Response(JSON.stringify({ detail: 'run not found', code: 'NOT_FOUND' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })

    await expect(consumeInsightStream(response)).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      message: 'run not found',
    })
  })

  it('honors abort while the reader is waiting', async () => {
    const controller = new AbortController()
    const { promise: pendingRead } = Promise.withResolvers<void>()
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          return pendingRead
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } }
    )

    const consuming = consumeInsightStream(response, { signal: controller.signal })
    controller.abort()

    await expect(consuming).rejects.toMatchObject({ name: 'AbortError' })
  })
})

