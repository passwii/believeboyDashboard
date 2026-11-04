import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { InsightStreamPanel } from './insight-stream-panel'
import { useInsightStream, type InsightStreamClientStatus } from '@/hooks/use-insight-stream'
import { InsightClient } from '@/lib/insight/client'
import { isInsightEventType, type InsightEvent, type InsightRunRequest } from '@/lib/insight/protocol'

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
  return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
}

/** 发出内容后保持连接，用于需要观察稳定 live 状态的用例。 */
function openSseResponse(payload: string): Response {
  const encoder = new TextEncoder()
  let sent = false
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) return new Promise<void>(() => {})
      sent = true
      controller.enqueue(encoder.encode(payload))
    },
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
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

const RUN_LABELS: Record<string, string> = {
  queued: '排队中',
  aggregating: '正在聚合数据',
  generating: '正在生成结论',
  finalizing: '正在收尾',
  completed: '已完成',
  failed: '生成失败',
  cancelled: '已取消',
}

const TRANSPORT_LABELS: Partial<Record<InsightStreamClientStatus, string>> = {
  queued: '排队中',
  connecting: '正在连接',
  live: '正在生成',
  reconnecting: '连接中断，正在重连',
  completed: '已完成',
  failed: '生成失败',
  cancelled: '已取消',
}

const CONTENT_SHA256 = 'c362e6be96ca4a23089bf5366d393f6e167875244c055db525ecdeb938ec2607'

function Harness({ client }: { client: InsightClient }) {
  const [digest, setDigest] = useState<string | null>(null)
  const stream = useInsightStream({
    client,
    reconnectDelayMs: 0,
    maxReconnectAttempts: 1,
    onEvent: (event) => {
      if (isInsightEventType(event, 'done') && typeof event.content_sha256 === 'string') {
        setDigest(event.content_sha256)
      }
    },
  })
  const statusLabel =
    (stream.runStatus ? RUN_LABELS[stream.runStatus] : undefined) ??
    TRANSPORT_LABELS[stream.status] ??
    stream.status
  return (
    <>
      <button type="button" onClick={() => void stream.start(CANONICAL_REQUEST)}>
        启动
      </button>
      <button type="button" onClick={() => void stream.retry()}>
        重试 run
      </button>
      <InsightStreamPanel
        status={stream.runStatus ?? stream.status}
        statusLabel={statusLabel}
        error={stream.error}
        backgroundMessage={stream.backgroundMessage}
        content={stream.partialDrafts.main ?? ''}
        contentState={stream.runStatus === 'completed' ? 'final' : 'draft'}
        isStreaming={stream.status === 'live' || stream.status === 'connecting'}
        digest={digest ?? undefined}
        onRetry={() => void stream.retry()}
        onCancel={() => void stream.cancel()}
        onClose={() => stream.detach()}
        slots={{ header: <span>报告摘要</span> }}
      />
    </>
  )
}

describe('InsightStreamPanel', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('walks queued → live → completed from a fake stream, rendering drafts then the final markdown', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ run_id: 'run-1', status: 'queued', attempt: 1 }))
      .mockResolvedValueOnce(
        sseResponse(
          event('status', {
            id: 'e1',
            status: 'aggregating',
            stage: 'aggregating',
            progress_percent: 30,
          }) +
            event('content.delta', { id: 'e2', seq: 2, slot: 'main', delta: '## 结论\n' }) +
            event('content.delta', { id: 'e3', seq: 3, slot: 'main', delta: '增长稳健\n' }) +
            event('done', {
              id: 'e4',
              seq: 4,
              outputs: { main: { content: '## 结论\n增长稳健\n' } },
              content_sha256: CONTENT_SHA256,
            })
        )
      )
    const client = new InsightClient({ fetch: fetchMock })
    render(<Harness client={client} />)

    fireEvent.click(screen.getByRole('button', { name: '启动' }))

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已完成'))
    const region = document.querySelector('[role="document"]')
    expect(region).toHaveAttribute('data-state', 'final')
    expect(region).toHaveAttribute('data-content-digest', CONTENT_SHA256)
    expect(screen.getByRole('heading', { name: '结论' })).toBeInTheDocument()
  })

  it('shows the adapter stage label while live and keeps it off the whole document', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ run_id: 'run-1', status: 'queued', attempt: 1 }))
      .mockResolvedValueOnce(
        openSseResponse(
          event('status', { id: 'e1', status: 'aggregating', stage: 'aggregating' }) +
            event('content.snapshot', {
              id: 'e2',
              seq: 2,
              slot: 'main',
              content: '草稿内容',
              format: 'markdown',
              checkpoint_seq: 1,
            })
        )
      )
    const client = new InsightClient({ fetch: fetchMock })
    render(<Harness client={client} />)

    fireEvent.click(screen.getByRole('button', { name: '启动' }))

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('正在聚合数据')
      expect(document.querySelector('[role="document"]')).toHaveAttribute('aria-busy', 'true')
    })
    expect(document.querySelectorAll('[role="status"]')).toHaveLength(1)
  })

  it('renders a retryable failure and retries the run on demand', async () => {
    const errorEvent: InsightEvent = {
      schema_version: 1,
      run_id: 'run-1',
      attempt: 1,
      seq: 1,
      type: 'error',
      status: 'failed',
      error: { code: 'MODEL_UNAVAILABLE', message: '模型暂不可用', retryable: true },
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ run_id: 'run-1', status: 'queued', attempt: 1 }))
      .mockResolvedValueOnce(sseResponse(`id: e1\ndata: ${JSON.stringify(errorEvent)}\n\n`))
      .mockResolvedValueOnce(jsonResponse({ run_id: 'run-1', status: 'queued', attempt: 2 }))
      .mockResolvedValueOnce(
        sseResponse(
          event('status', { id: 'e2', status: 'generating', stage: 'generating' }) +
            event('done', { id: 'e3', seq: 2, outputs: { main: { content: '重试成功\n' } } })
        )
      )
    const client = new InsightClient({ fetch: fetchMock })
    render(<Harness client={client} />)

    fireEvent.click(screen.getByRole('button', { name: '启动' }))

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('模型暂不可用'))
    expect(screen.getByText('MODEL_UNAVAILABLE · 可重试')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '重试' }))

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已完成'))
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/backend/v1/insight/runs/run-1/retry')
  })

  it('cancels an active run through the explicit cancel action', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ run_id: 'run-1', status: 'queued', attempt: 1 }))
      .mockResolvedValueOnce(
        sseResponse(event('status', { id: 'e1', status: 'generating', stage: 'generating' }))
      )
      .mockResolvedValueOnce(jsonResponse({ run_id: 'run-1', status: 'cancelled' }))
    const client = new InsightClient({ fetch: fetchMock })
    render(<Harness client={client} />)

    fireEvent.click(screen.getByRole('button', { name: '启动' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('正在生成结论'))

    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已取消'))
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/backend/v1/insight/runs/run-1/cancel')
  })

  it('keeps partial content and surfaces the background message when the panel closes mid-run', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ run_id: 'run-1', status: 'queued', attempt: 1 }))
      .mockResolvedValueOnce(
        sseResponse(
          event('status', { id: 'e1', status: 'generating', stage: 'generating' }) +
            event('content.delta', { id: 'e2', seq: 2, slot: 'main', delta: '已生成的部分内容' })
        )
      )
    const client = new InsightClient({ fetch: fetchMock })
    render(<Harness client={client} />)

    fireEvent.click(screen.getByRole('button', { name: '启动' }))
    await waitFor(() => expect(screen.getByRole('document')).toHaveTextContent(/部分内容/))

    fireEvent.click(screen.getByRole('button', { name: '关闭' }))

    expect(screen.getByText('已转入后台继续生成')).toBeInTheDocument()
    expect(document.querySelector('[data-insight-panel]')).toHaveAttribute('data-detached', 'true')
    expect(screen.getByRole('document')).toHaveTextContent(/部分内容/)
  })

  it('renders every declared slot, including a collapsed inspector', () => {
    render(
      <InsightStreamPanel
        status="live"
        statusLabel="正在生成第 2 节"
        content={'内容\n'}
        slots={{
          header: <span>头部</span>,
          meta: <span>元信息</span>,
          status: <span>自定义状态</span>,
          beforeContent: <span>内容前</span>,
          afterContent: <span>内容后</span>,
          actions: <span>操作区</span>,
          inspector: <span>原始流</span>,
        }}
      />
    )

    for (const text of ['头部', '元信息', '自定义状态', '内容前', '内容后', '操作区']) {
      expect(screen.getByText(text)).toBeInTheDocument()
    }
    expect(screen.queryByText('原始流')).not.toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: /详情/ }))
    expect(screen.getByText('原始流')).toBeVisible()
  })

  it('forwards the Warm presentation and class boundaries to nested surfaces', () => {
    const { container } = render(
      <InsightStreamPanel
        appearance="warm"
        status="live"
        statusLabel="正在生成第 2 节"
        content={'## 结论\n增长稳健\n'}
        onClose={() => {}}
        statusClassName="page-status"
        markdownClassName="page-markdown"
        copyExportClassName="page-copy-export"
      />
    )

    expect(container.querySelector('[data-insight-panel]')).toHaveAttribute(
      'data-insight-appearance',
      'warm'
    )
    expect(container.querySelector('[data-insight-status]')).toHaveAttribute(
      'data-insight-appearance',
      'warm'
    )
    expect(container.querySelector('[data-insight-status]')).toHaveClass('page-status')
    expect(container.querySelector('[data-insight-markdown]')).toHaveAttribute(
      'data-insight-appearance',
      'warm'
    )
    expect(container.querySelector('[data-insight-markdown]')).toHaveClass('page-markdown')
    expect(container.querySelector('[data-insight-raw-actions]')).toHaveClass(
      'page-copy-export'
    )
    expect(screen.getByRole('button', { name: '关闭' })).toHaveClass(
      'warm-ledger__icon-button'
    )
  })

  function stubGeometry(node: HTMLElement, state: { scrollTop: number; scrollHeight: number; clientHeight: number }) {
    Object.defineProperty(node, 'scrollHeight', { value: state.scrollHeight, configurable: true })
    Object.defineProperty(node, 'clientHeight', { value: state.clientHeight, configurable: true })
    Object.defineProperty(node, 'scrollTop', {
      value: state.scrollTop,
      writable: true,
      configurable: true,
    })
  }

  it('does not force the reader to the bottom, offering a new-content entry instead', () => {
    const { container, rerender } = render(<InsightStreamPanel status="live" statusLabel="生成中" content={'第一段\n'} />)
    const scroller = container.querySelector('[data-insight-scroll]') as HTMLElement
    const scrollTo = vi.spyOn(scroller, 'scrollTo').mockImplementation(() => {})
    stubGeometry(scroller, { scrollTop: 0, scrollHeight: 1_000, clientHeight: 200 })

    fireEvent.scroll(scroller)
    rerender(<InsightStreamPanel status="live" statusLabel="生成中" content={'第一段\n第二段\n'} />)

    expect(scrollTo).not.toHaveBeenCalled()
    const entry = screen.getByRole('button', { name: /有新内容/ })

    fireEvent.click(entry)

    expect(scrollTo).toHaveBeenCalledWith({ top: 1_000, behavior: 'smooth' })
    expect(screen.queryByRole('button', { name: /有新内容/ })).toBeNull()
  })

  it('follows new content while the reader is already at the bottom, without smooth scrolling', () => {
    const { container, rerender } = render(<InsightStreamPanel status="live" statusLabel="生成中" content={'第一段\n'} />)
    const scroller = container.querySelector('[data-insight-scroll]') as HTMLElement
    const scrollTo = vi.spyOn(scroller, 'scrollTo').mockImplementation(() => {})
    stubGeometry(scroller, { scrollTop: 800, scrollHeight: 1_000, clientHeight: 200 })

    fireEvent.scroll(scroller)
    scrollTo.mockClear()
    rerender(<InsightStreamPanel status="live" statusLabel="生成中" content={'第一段\n第二段\n'} />)

    expect(scrollTo).toHaveBeenCalledWith({ top: 1_000, behavior: 'auto' })
    expect(screen.queryByRole('button', { name: /有新内容/ })).toBeNull()
  })

  function stubReducedMotion(enabled: boolean): () => void {
    const original = window.matchMedia
    Object.defineProperty(window, 'matchMedia', {
      value: (query: string) => ({
        matches: enabled && query.includes('prefers-reduced-motion'),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
      configurable: true,
      writable: true,
    })
    return () => {
      Object.defineProperty(window, 'matchMedia', { value: original, configurable: true, writable: true })
    }
  }

  function renderScrolledUpPanel(): { container: HTMLElement; rerender: (ui: React.ReactElement) => void } {
    const { container, rerender } = render(
      <InsightStreamPanel status="live" statusLabel="生成中" content={'第一段\n'} isStreaming />
    )
    const scroller = container.querySelector('[data-insight-scroll]') as HTMLElement
    stubGeometry(scroller, { scrollTop: 0, scrollHeight: 1_000, clientHeight: 200 })
    fireEvent.scroll(scroller)
    rerender(<InsightStreamPanel status="live" statusLabel="生成中" content={'第一段\n第二段\n'} isStreaming />)
    return { container, rerender }
  }

  it('blinks a caret at the tail while streaming', () => {
    const restore = stubReducedMotion(false)
    try {
      const { container } = render(
        <InsightStreamPanel status="live" statusLabel="生成中" content={'正文\n未完成'} isStreaming />
      )
      expect(container.querySelector('[data-insight-caret]')).not.toBeNull()
    } finally {
      restore()
    }
  })

  it('drops the caret and smooth scrolling under reduced motion', () => {
    const restore = stubReducedMotion(true)
    try {
      const { container } = renderScrolledUpPanel()

      expect(container.querySelector('[data-insight-caret]')).toBeNull()

      const scroller = container.querySelector('[data-insight-scroll]') as HTMLElement
      const scrollTo = vi.spyOn(scroller, 'scrollTo').mockImplementation(() => {})
      fireEvent.click(screen.getByRole('button', { name: /有新内容/ }))

      expect(scrollTo).toHaveBeenCalledWith({ top: 1_000, behavior: 'auto' })
    } finally {
      restore()
    }
  })
})
