import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { InsightClient } from '@/lib/insight/client'
import type { InsightRunStartResponse } from '@/lib/insight/protocol'
import { useAdInsight } from './use-ad-insight'

/**
 * BLF-1017：广告分析的写端已切到 canonical 域端点
 * （`POST /api/backend/v1/insight/ad-analysis/runs`），读端（detail / SSE / 重连 /
 * retry / cancel）全部交给共享 `useInsightStream`。
 *
 * 这里钉住三件事：提交口径正确（页面口径 → 域请求体）、终态 run 由 detail 直接
 * 出终稿（不额外开流）、口径不全时不提交且状态可见。
 */
const SCOPE = {
  projectId: 7,
  country: 'US',
  from: new Date(2026, 8, 1),
  to: new Date(2026, 8, 7),
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('useAdInsight', () => {
  it('提交 canonical 广告 run，并用 detail 里的终稿填充面板', async () => {
    const startRun = vi
      .fn()
      .mockResolvedValue({
        run_id: 'ad-run-1',
        status: 'queued',
        attempt: 1,
      } satisfies InsightRunStartResponse)
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        run_id: 'ad-run-1',
        status: 'completed',
        attempt: 1,
        title: '广告周报',
        outputs: { main: { format: 'markdown', content: '# 广告正文' } },
      })
    )
    const client = new InsightClient({ fetch: fetchMock })

    const { result } = renderHook(() =>
      useAdInsight({ open: true, scope: SCOPE, startRun, client })
    )

    await waitFor(() => expect(result.current.panel.content).toBe('# 广告正文'))
    expect(startRun).toHaveBeenCalledTimes(1)
    expect(startRun).toHaveBeenCalledWith(
      '/api/backend/v1/insight/ad-analysis/runs',
      {
        project_id: 7,
        country: 'US',
        start_date: '2026-09-01',
        end_date: '2026-09-07',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(result.current.runId).toBe('ad-run-1')
    expect(result.current.panel.state.status).toBe('completed')
    expect(result.current.panel.contentState).toBe('final')
    expect(result.current.panel.title).toBe('广告周报')
    // 终态 run 不再订阅 SSE：只有一次 detail 读。
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/backend/v1/insight/runs/ad-run-1')
  })

  it('口径不全时不提交，并把缺失提示落成可见错误', async () => {
    const startRun = vi.fn()
    const client = new InsightClient({ fetch: vi.fn() })

    const { result } = renderHook(() =>
      useAdInsight({
        open: true,
        scope: { projectId: 7, country: 'US', from: null, to: null },
        startRun,
        client,
      })
    )

    await waitFor(() =>
      expect(result.current.panel.error?.message).toBe('请先选择项目与日期范围')
    )
    expect(startRun).not.toHaveBeenCalled()
    expect(result.current.runId).toBeNull()
  })

  it('run 已建但 detail 读不回：给出可见失败与「重试」，不停在「取消」', async () => {
    const startRun = vi.fn().mockResolvedValue({
      run_id: 'ad-run-2',
      status: 'queued',
      attempt: 1,
    } satisfies InsightRunStartResponse)
    // 建 run 成功，但回读 detail 就失败：这条路径上共享 hook 只把「传输层失败」
    // 写进状态，run 状态始终为空——正是容易退化成「只有取消、没有重试」的情形。
    const fetchMock = vi.fn(() => Promise.reject(new Error('backend unreachable')))
    const client = new InsightClient({ fetch: fetchMock as unknown as typeof fetch })

    const { result } = renderHook(() =>
      useAdInsight({ open: true, scope: SCOPE, startRun, client, reconnectDelayMs: 1 })
    )

    await waitFor(() => expect(result.current.panel.state.status).toBe('failed'))
    expect(result.current.runId).toBe('ad-run-2')
    expect(result.current.panel.state.label).toBe('广告分析生成失败')
    // 已经无法推进：不给「取消」，且必须留下「重试」的出路。
    expect(result.current.panel.state.busy).toBe(false)
    expect(result.current.panel.onCancel).toBeUndefined()
    expect(result.current.panel.onRetry).toBeTypeOf('function')
  })

  it('入口关闭时不提交', () => {
    const startRun = vi.fn()
    const client = new InsightClient({ fetch: vi.fn() })

    const { result } = renderHook(() =>
      useAdInsight({ open: false, scope: SCOPE, startRun, client })
    )

    expect(startRun).not.toHaveBeenCalled()
    expect(result.current.panel.error).toBeNull()
    expect(result.current.panel.content).toBe('')
  })
})
