import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { LegacyInsightFrame } from './legacy-insight-compat'
import { useLegacyInsightStream } from './use-legacy-insight-stream'

/**
 * BLF-1017 验收 §1/§2：旧洞察页的兼容订阅 hook 是**唯一**的 legacy 流入口。
 *
 * 旧后端每次订阅都从当前状态重放（`ai_insight.py::stream_insight`），浏览器的
 * EventSource 又会在断流后自动重连——若本地累积不清空，"同一 run 重连"就会把
 * 正文写两遍。这里用可控的假 EventSource 钉住该行为，以及终态收口（关流 + 转发
 * onFrame 让父级刷新列表）与"无 EventSource 环境不伪造数据"两条底线。
 */

type FakeSource = {
  es: EventSource
  open: () => void
  emit: (frame: LegacyInsightFrame) => void
  fail: () => void
  readonly closed: boolean
}

function createFakeSource(): FakeSource {
  const handlers: {
    onopen: (() => void) | null
    onerror: (() => void) | null
    onmessage: ((event: MessageEvent) => void) | null
  } = { onopen: null, onerror: null, onmessage: null }
  let closed = false

  const es = {
    get onopen() {
      return handlers.onopen
    },
    set onopen(value) {
      handlers.onopen = value
    },
    get onerror() {
      return handlers.onerror
    },
    set onerror(value) {
      handlers.onerror = value
    },
    get onmessage() {
      return handlers.onmessage
    },
    set onmessage(value) {
      handlers.onmessage = value
    },
    close() {
      closed = true
    },
  } as unknown as EventSource

  return {
    es,
    open: () => handlers.onopen?.(),
    emit: (frame) =>
      handlers.onmessage?.(new MessageEvent('message', { data: JSON.stringify(frame) })),
    fail: () => handlers.onerror?.(),
    get closed() {
      return closed
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useLegacyInsightStream', () => {
  it('重连后清空本地累积，同一 run 不重复文本', async () => {
    const fake = createFakeSource()
    const frames: LegacyInsightFrame[] = []
    const { result } = renderHook(() =>
      useLegacyInsightStream({
        insightId: 77,
        enabled: true,
        createSource: () => fake.es,
        onFrame: (frame) => frames.push(frame),
      })
    )

    act(() => {
      fake.open()
      fake.emit({ type: 'status', status: 'generating', sub_status: 'ai_generating' })
      fake.emit({ type: 'chunk', delta: '上半段' })
    })
    await waitFor(() => expect(result.current.content).toBe('上半段'))

    // 浏览器自动重连：旧流从头重放，本地累积必须先清空
    act(() => {
      fake.open()
      fake.emit({ type: 'chunk', delta: '完整正文' })
    })
    await waitFor(() => expect(result.current.content).toBe('完整正文'))
    expect(result.current.state.busy).toBe(true)
  })

  it('断流只反映为重连中，不结束 run', async () => {
    const fake = createFakeSource()
    const { result } = renderHook(() =>
      useLegacyInsightStream({ insightId: 78, enabled: true, createSource: () => fake.es })
    )

    act(() => {
      fake.open()
      fake.emit({ type: 'status', status: 'generating', sub_status: 'data_aggregating_sales' })
    })
    act(() => {
      fake.fail()
    })

    await waitFor(() => expect(result.current.state.status).toBe('reconnecting'))
    expect(result.current.finished).toBe(false)
    expect(fake.closed).toBe(false)
  })

  it('终态帧收口并转发给父级（供列表/详情刷新）', async () => {
    const fake = createFakeSource()
    const frames: LegacyInsightFrame[] = []
    const { result } = renderHook(() =>
      useLegacyInsightStream({
        insightId: 79,
        enabled: true,
        createSource: () => fake.es,
        onFrame: (frame) => frames.push(frame),
      })
    )

    act(() => {
      fake.open()
      fake.emit({ type: 'done', title: '9 月洞察', status: 'completed', content: '终稿正文' })
    })

    await waitFor(() => expect(result.current.finished).toBe(true))
    expect(result.current.content).toBe('终稿正文')
    expect(result.current.title).toBe('9 月洞察')
    expect(result.current.state.contentState).toBe('final')
    expect(fake.closed).toBe(true)
    expect(frames.map((frame) => frame.type)).toEqual(['done'])
  })

  it('失败帧落成可展示的错误并停流', async () => {
    const fake = createFakeSource()
    const { result } = renderHook(() =>
      useLegacyInsightStream({ insightId: 80, enabled: true, createSource: () => fake.es })
    )

    act(() => {
      fake.open()
      fake.emit({ type: 'error', error: '模型不可用', status: 'failed' })
    })

    await waitFor(() => expect(result.current.state.status).toBe('failed'))
    expect(result.current.error?.message).toBe('模型不可用')
    expect(fake.closed).toBe(true)
  })

  it('未启用时不订阅，也不伪造数据', () => {
    const createSource = vi.fn()
    const { result } = renderHook(() =>
      useLegacyInsightStream({ insightId: 81, enabled: false, createSource })
    )

    expect(createSource).not.toHaveBeenCalled()
    expect(result.current.content).toBe('')
    expect(result.current.finished).toBe(false)
  })

  it('环境无 EventSource 时不订阅、不抛错', () => {
    const createSource = vi.fn()
    const original = globalThis.EventSource
    // jsdom 不实现 EventSource；显式删除以复现 SSR / 未注入环境
    Reflect.deleteProperty(globalThis, 'EventSource')
    try {
      const { result } = renderHook(() =>
        useLegacyInsightStream({ insightId: 82, enabled: true, createSource: undefined })
      )
      expect(result.current.content).toBe('')
      expect(result.current.state.status).toBe('queued')
      expect(createSource).not.toHaveBeenCalled()
    } finally {
      if (original) globalThis.EventSource = original
    }
  })
})
