import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { InsightClient } from '@/lib/insight/client'
import type { InsightRunActionResponse, InsightRunDetail } from '@/lib/insight/protocol'
import { useLedgerInsight } from './use-ledger-insight'
import type { LedgerItem } from './types'

function makeItem(overrides: Partial<LedgerItem> = {}): LedgerItem {
  return {
    id: 11,
    ledger_key: 'lk-1',
    expected_date: '2026-08-24',
    expected_at: '2026-08-24T15:00:00+08:00',
    frequency: 'weekly',
    subscription_id: 7,
    email: 'ops@example.com',
    project_ids: '1,2',
    project_names: ['项目A'],
    country: 'US',
    status: 'sent',
    latest_delivery_log_id: 99,
    error_message: null,
    sent_at: '2026-08-24T15:05:00+08:00',
    can_resend: false,
    last_checked_at: null,
    screenshot_r2_url: null,
    screenshot_r2_thumb_url: null,
    ai_summary: null,
    ai_summary_status: 'pending',
    ai_summary_error: null,
    ai_summary_model: null,
    ai_summary_updated_at: null,
    ...overrides,
  }
}

function detail(overrides: Partial<InsightRunDetail> = {}): InsightRunDetail {
  return {
    run_id: 'run-1',
    attempt: 1,
    status: 'generating',
    ...overrides,
  }
}

function actionResponse(status: string): InsightRunActionResponse {
  return { run_id: 'run-1', attempt: 2, status }
}

/** 只实现 adapter 会用到的那几条 client 能力，其余调用会直接暴露成断言失败。 */
function makeClient(detailResponse: InsightRunDetail) {
  const calls = { detail: 0, stream: 0, cancel: 0, retry: 0 }
  const client = {
    detail: vi.fn(async () => {
      calls.detail += 1
      return detailResponse
    }),
    stream: vi.fn(() => {
      calls.stream += 1
      // 永不结束的流：adapter 的订阅行为可被单独观察。
      return new Promise<Response>(() => {})
    }),
    cancel: vi.fn(async () => {
      calls.cancel += 1
      return actionResponse('cancelled')
    }),
    retry: vi.fn(async () => {
      calls.retry += 1
      return actionResponse('queued')
    }),
  }
  return { client: client as unknown as InsightClient, raw: client, calls }
}

describe('useLedgerInsight（BLF-1015）', () => {
  it('无 run 绑定时不触碰 Insight client，直接读历史摘要', async () => {
    const { client, raw } = makeClient(detail())
    const item = makeItem({ ai_summary_status: 'done', ai_summary: '● 历史正文' })

    const { result } = renderHook(() =>
      useLedgerInsight({ open: true, item, regenerating: false, client })
    )

    expect(result.current.runBound).toBe(false)
    expect(result.current.panel.content).toBe('- 历史正文')
    expect(result.current.panel.contentState).toBe('final')
    expect(result.current.panel.onCancel).toBeUndefined()
    expect(result.current.panel.onRetry).toBeUndefined()
    expect(result.current.panel.error).toBeNull()
    expect(raw.detail).not.toHaveBeenCalled()
    expect(raw.stream).not.toHaveBeenCalled()
  })

  it('绑定 run 时只 attach 一次，重复渲染不重复订阅', async () => {
    const { client, raw } = makeClient(detail())
    const item = makeItem({ insight_run_id: 'run-1' })

    const { result, rerender } = renderHook(
      (props: { open: boolean }) =>
        useLedgerInsight({ open: props.open, item, regenerating: false, client }),
      { initialProps: { open: true } }
    )

    await waitFor(() => expect(raw.detail).toHaveBeenCalledTimes(1))
    expect(raw.detail).toHaveBeenCalledWith('run-1')
    rerender({ open: true })
    await act(async () => {
      await Promise.resolve()
    })
    expect(raw.detail).toHaveBeenCalledTimes(1)
    expect(raw.stream).toHaveBeenCalledTimes(1)
    expect(result.current.runBound).toBe(true)
  })

  it('切换到另一个 run 时，在新 run attach 完成前不展示或回写上一个摘要', async () => {
    let resolveSecondDetail!: (value: InsightRunDetail) => void
    const secondDetail = new Promise<InsightRunDetail>((resolve) => {
      resolveSecondDetail = resolve
    })
    const client = {
      detail: vi.fn()
        .mockResolvedValueOnce(
          detail({
            status: 'completed',
            outputs: { main: { format: 'markdown', content: '第一条记录的摘要' } },
          })
        )
        .mockReturnValueOnce(secondDetail),
      stream: vi.fn(() => new Promise<Response>(() => {})),
      cancel: vi.fn(),
      retry: vi.fn(),
    } as unknown as InsightClient
    const onItemRefreshed = vi.fn()
    const firstItem = makeItem({ insight_run_id: 'run-1', ai_summary_status: 'generating' })
    const secondItem = makeItem({
      ledger_key: 'lk-2',
      insight_run_id: 'run-2',
      ai_summary_status: 'pending',
    })

    const { result, rerender } = renderHook(
      ({ item }: { item: LedgerItem }) =>
        useLedgerInsight({ open: true, item, regenerating: false, onItemRefreshed, client }),
      { initialProps: { item: firstItem } }
    )

    await waitFor(() => expect(result.current.panel.content).toBe('第一条记录的摘要'))
    rerender({ item: secondItem })

    expect(result.current.panel.content).toBe('')
    expect(result.current.panel.state.status).toBe('queued')
    expect(onItemRefreshed).not.toHaveBeenCalledWith(
      expect.objectContaining({ ledger_key: 'lk-2', ai_summary: '第一条记录的摘要' })
    )

    await act(async () => {
      resolveSecondDetail(
        detail({
          run_id: 'run-2',
          status: 'completed',
          outputs: { main: { format: 'markdown', content: '第二条记录的摘要' } },
        })
      )
      await secondDetail
    })
    await waitFor(() => expect(result.current.panel.content).toBe('第二条记录的摘要'))
  })

  it('详情已是终态时直接回读正文，不再开流（避免同一 run 重复订阅）', async () => {
    const { client, raw } = makeClient(
      detail({
        status: 'completed',
        outputs: { main: { format: 'markdown', content: '后台完成的正文' } },
      })
    )
    const item = makeItem({ insight_run_id: 'run-1', ai_summary_status: 'generating' })
    const onItemRefreshed = vi.fn()

    const { result } = renderHook(() =>
      useLedgerInsight({ open: true, item, regenerating: false, onItemRefreshed, client })
    )

    await waitFor(() => expect(result.current.panel.content).toBe('后台完成的正文'))
    expect(result.current.panel.contentState).toBe('final')
    expect(result.current.panel.state.status).toBe('completed')
    expect(raw.stream).not.toHaveBeenCalled()

    await waitFor(() => expect(onItemRefreshed).toHaveBeenCalledTimes(1))
    expect(onItemRefreshed).toHaveBeenCalledWith(
      expect.objectContaining({
        insight_run_id: 'run-1',
        ai_summary: '后台完成的正文',
        ai_summary_status: 'done',
        ai_summary_error: null,
      })
    )
  })

  it('详情为失败终态时暴露错误、写回 failed 并提供共享重试', async () => {
    const { client, raw } = makeClient(
      detail({
        status: 'failed',
        error: { code: 'PROVIDER_TIMEOUT', message: '模型超时' },
      })
    )
    const item = makeItem({ insight_run_id: 'run-1', ai_summary_status: 'generating' })
    const onItemRefreshed = vi.fn()

    const { result } = renderHook(() =>
      useLedgerInsight({ open: true, item, regenerating: false, onItemRefreshed, client })
    )

    await waitFor(() => expect(result.current.panel.state.status).toBe('failed'))
    expect(result.current.panel.error?.message).toBe('模型超时')
    expect(result.current.panel.onRetry).toBeTypeOf('function')
    expect(result.current.panel.onCancel).toBeUndefined()

    await waitFor(() =>
      expect(onItemRefreshed).toHaveBeenCalledWith(
        expect.objectContaining({
          insight_run_id: 'run-1',
          ai_summary_status: 'failed',
          ai_summary_error: '模型超时',
        })
      )
    )

    await act(async () => {
      result.current.panel.onRetry?.()
    })
    expect(raw.retry).toHaveBeenCalledWith('run-1')
  })

  it('运行中可显式取消，且取消不会被当成失败写回列表', async () => {
    const { client, raw } = makeClient(detail())
    const item = makeItem({ insight_run_id: 'run-1', ai_summary: '旧正文' })
    const onItemRefreshed = vi.fn()

    const { result } = renderHook(() =>
      useLedgerInsight({ open: true, item, regenerating: false, onItemRefreshed, client })
    )

    await waitFor(() => expect(result.current.panel.state.busy).toBe(true))
    expect(result.current.panel.onCancel).toBeTypeOf('function')

    await act(async () => {
      result.current.panel.onCancel?.()
    })

    expect(raw.cancel).toHaveBeenCalledWith('run-1')
    expect(result.current.panel.state.status).toBe('cancelled')
    expect(result.current.panel.state.busy).toBe(false)
    expect(onItemRefreshed).not.toHaveBeenCalled()
  })

  it('关闭详情只断本地订阅，不取消服务端 run', async () => {
    const { client, raw } = makeClient(detail())
    const item = makeItem({ insight_run_id: 'run-1' })

    const { rerender } = renderHook(
      (props: { open: boolean }) =>
        useLedgerInsight({ open: props.open, item, regenerating: false, client }),
      { initialProps: { open: true } }
    )

    await waitFor(() => expect(raw.detail).toHaveBeenCalledTimes(1))
    rerender({ open: false })
    await act(async () => {
      await Promise.resolve()
    })

    expect(raw.cancel).not.toHaveBeenCalled()
    expect(raw.detail).toHaveBeenCalledTimes(1)
  })

  it('重新打开详情会重新 attach，恢复后台 run 的最新状态', async () => {
    const { client, raw } = makeClient(detail())
    const item = makeItem({ insight_run_id: 'run-1' })

    const { rerender } = renderHook(
      (props: { open: boolean }) =>
        useLedgerInsight({ open: props.open, item, regenerating: false, client }),
      { initialProps: { open: true } }
    )
    await waitFor(() => expect(raw.detail).toHaveBeenCalledTimes(1))

    rerender({ open: false })
    await act(async () => {
      await Promise.resolve()
    })
    rerender({ open: true })

    await waitFor(() => expect(raw.detail).toHaveBeenCalledTimes(2))
  })
})
