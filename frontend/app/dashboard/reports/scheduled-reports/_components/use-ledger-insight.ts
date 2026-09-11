'use client'

import { useEffect, useRef, useState } from 'react'

import { useInsightStream } from '@/hooks/use-insight-stream'
import { InsightClient } from '@/lib/insight/client'
import {
  isInsightEventType,
  type InsightErrorPayload,
  type InsightRunStatus,
  type InsightStreamStatus,
} from '@/lib/insight/protocol'
import {
  ledgerRunId,
  toLedgerPanelContent,
  toLedgerPanelState,
  toLedgerSummaryStatus,
  type LedgerSummaryPanelState,
} from './ledger-insight'
import type { LedgerItem } from './types'

/**
 * 台账详情 ↔ 共享 Insight run 的胶水层（BLF-1015）。
 *
 * 共享 hook 负责订阅/重连/取消/重试，这里只做两件台账特有的事：
 * 1. 条目上带 run 绑定时 `attach` 接管（终态直接回读 detail，不重开流）；
 * 2. run 跑到终态时把结果写回条目，让列表与详情无需刷新即可看到后台状态。
 */
export type LedgerInsightPanel = {
  state: LedgerSummaryPanelState
  content: string
  contentState: 'draft' | 'final'
  digest: string | null
  error: InsightErrorPayload | null
  backgroundMessage: string | null
  onCancel?: () => void
  onRetry?: () => void
}

export type UseLedgerInsightOptions = {
  open: boolean
  item: LedgerItem | null
  /** 父级 view 正在为该条目跑 regenerate（乐观锁） */
  regenerating: boolean
  onItemRefreshed?: (item: LedgerItem) => void
  /** 测试注入用；默认走 Next 代理下的 `/api/backend/v1/insight/runs` */
  client?: InsightClient
  reconnectDelayMs?: number
}

/** 传输层终态 → canonical 状态：详情拉取失败等场景 hook 只给出传输层结论。 */
function toTerminalRunStatus(status: InsightStreamStatus): InsightRunStatus | null {
  if (status === 'completed' || status === 'failed' || status === 'cancelled') return status
  return null
}

export function useLedgerInsight(options: UseLedgerInsightOptions): {
  panel: LedgerInsightPanel
  runBound: boolean
} {
  const { open, item, regenerating, onItemRefreshed } = options
  const clientRef = useRef(options.client)
  if (!clientRef.current) clientRef.current = new InsightClient()
  const onItemRefreshedRef = useRef(onItemRefreshed)
  onItemRefreshedRef.current = onItemRefreshed

  const [digest, setDigest] = useState<string | null>(null)
  const attachedRef = useRef<string | null>(null)
  const reportedRef = useRef<string | null>(null)

  const stream = useInsightStream({
    client: clientRef.current,
    reconnectDelayMs: options.reconnectDelayMs ?? 1_000,
    onEvent: (event) => {
      if (isInsightEventType(event, 'done') && typeof event.content_sha256 === 'string') {
        setDigest(event.content_sha256)
      }
    },
  })

  const runId = ledgerRunId(item)
  const runBound = runId !== null
  const liveContent = stream.partialDrafts.main ?? ''
  const effectiveRunStatus =
    stream.runStatus ?? (runBound ? toTerminalRunStatus(stream.status) : null)

  // 打开详情时接管后台 run；关闭详情只断开本地订阅，服务端 run 继续跑。
  const attach = stream.attach
  const detach = stream.detach
  useEffect(() => {
    if (!open || !runId) {
      if (attachedRef.current) {
        attachedRef.current = null
        detach()
      }
      return
    }
    if (attachedRef.current === runId) return
    attachedRef.current = runId
    reportedRef.current = null
    setDigest(null)
    // 详情拉取失败已由 hook 落到 error，面板自行展示。
    void attach(runId).catch(() => undefined)
  }, [open, runId, attach, detach])

  const runStatus = stream.runStatus
  const finishedContent = stream.drafts.main ?? ''
  const streamError = stream.error
  useEffect(() => {
    if (!item || !runId) return
    if (runStatus !== 'completed' && runStatus !== 'failed') return
    const key = `${runId}:${runStatus}`
    if (reportedRef.current === key) return
    reportedRef.current = key
    onItemRefreshedRef.current?.({
      ...item,
      insight_run_id: runId,
      ai_summary: finishedContent.trim() ? finishedContent : item.ai_summary,
      ai_summary_status: toLedgerSummaryStatus(runStatus),
      ai_summary_error: runStatus === 'failed' ? (streamError?.message ?? item.ai_summary_error) : null,
    })
  }, [item, runId, runStatus, finishedContent, streamError])

  const state = toLedgerPanelState({
    item,
    regenerating,
    runStatus: effectiveRunStatus,
    transport: stream.status,
    progress: stream.progress,
  })
  const { content, contentState } = toLedgerPanelContent({
    item,
    liveContent,
    runSettled: runStatus === 'completed',
  })

  const cancel = stream.cancel
  const retry = stream.retry
  const panel: LedgerInsightPanel = {
    state,
    content,
    contentState,
    digest: runBound ? digest : null,
    error: runBound ? streamError : null,
    backgroundMessage: runBound ? stream.backgroundMessage : null,
    onCancel:
      runBound && state.busy
        ? () => {
            void cancel()
          }
        : undefined,
    onRetry:
      runBound && effectiveRunStatus === 'failed'
        ? () => {
            void retry().catch(() => undefined)
          }
        : undefined,
  }

  return { panel, runBound }
}
