'use client'

import {
  useInsightDomainRun,
  type DomainRunStarter,
} from '@/hooks/use-insight-domain-run'
import { InsightClient } from '@/lib/insight/client'
import { AD_ANALYSIS_RUN_PATH, type AdAnalysisRunInput } from '@/lib/insight/domain-runs'
import type { InsightErrorPayload } from '@/lib/insight/protocol'
import {
  AD_OUTPUT_SLOT,
  toAdPanelState,
  toAdRunInput,
  type AdPanelState,
  type AdRunScope,
} from './ad-insight'

/**
 * 广告分析域适配器（BLF-1017）。
 *
 * 只做三件事：口径 → `AdAnalysisRunInput`、run 事实 → 广告文案、给出可点的
 * 取消/重试。提交、detail 回读、SSE、重连、resume、后台完成全在
 * `useInsightDomainRun`（其下是共享 `useInsightStream`）里——本文件不创建
 * EventSource、不解析 SSE、不持有 provider/retry 状态。
 */

export type AdInsightPanel = {
  state: AdPanelState
  /** 服务端在 `done` 事件里给出的报告标题；未完成时为 null */
  title: string | null
  /** canonical 输出槽 `main` 的当前内容（流式草稿或 detail 里的终稿） */
  content: string
  contentState: 'draft' | 'final'
  digest: string | null
  error: InsightErrorPayload | null
  backgroundMessage: string | null
  onCancel?: () => void
  onRetry?: () => void
}

export type UseAdInsightOptions = {
  open: boolean
  scope: AdRunScope
  /** 测试注入：默认提交 canonical 广告域端点 */
  startRun?: DomainRunStarter<AdAnalysisRunInput>
  /** 测试注入；默认走 Next 代理下的 `/api/backend/v1/insight/runs` */
  client?: InsightClient
  reconnectDelayMs?: number
  /** run 进入终态时回调，供父级刷新历史列表（后台完成也能看到） */
  onSettled?: () => void
}

export function useAdInsight(options: UseAdInsightOptions): {
  panel: AdInsightPanel
  runId: string | null
  replayed: boolean
} {
  const { open, scope } = options
  const facts = useInsightDomainRun<AdAnalysisRunInput>({
    open,
    path: AD_ANALYSIS_RUN_PATH,
    input: toAdRunInput(scope),
    incompleteMessage: '请先选择项目与日期范围',
    slot: AD_OUTPUT_SLOT,
    startRun: options.startRun,
    client: options.client,
    reconnectDelayMs: options.reconnectDelayMs,
    onSettled: () => options.onSettled?.(),
  })

  const state = toAdPanelState({
    runStatus: facts.runStatus,
    transport: facts.transport,
    progress: facts.progress,
  })

  return {
    runId: facts.runId,
    replayed: facts.replayed,
    panel: {
      state,
      title: facts.title,
      content: facts.content,
      contentState: facts.contentState,
      digest: facts.digest,
      error: facts.error,
      backgroundMessage: facts.backgroundMessage,
      onCancel:
        facts.actionable && state.busy
          ? () => {
              void facts.cancel()
            }
          : undefined,
      onRetry:
        facts.actionable && facts.runStatus === 'failed'
          ? () => {
              void facts.retry().catch(() => undefined)
            }
          : undefined,
    },
  }
}
