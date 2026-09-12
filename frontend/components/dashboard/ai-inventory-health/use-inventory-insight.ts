'use client'

import { useInsightDomainRun, type DomainRunStarter } from '@/hooks/use-insight-domain-run'
import { InsightClient } from '@/lib/insight/client'
import { INVENTORY_HEALTH_RUN_PATH, type InventoryHealthRunInput } from '@/lib/insight/domain-runs'
import type { InsightErrorPayload } from '@/lib/insight/protocol'
import {
  INVENTORY_OUTPUT_SLOT,
  toInventoryPanelState,
  toInventoryRunInput,
  type InventoryPanelState,
  type InventoryRunScope,
} from './inventory-insight'

/**
 * 库存健康域适配器（BLF-1017）。
 *
 * 与广告域同一个共享胶水层：口径 → `InventoryHealthRunInput`、run 事实 →
 * 库存文案、给出可点的取消/重试。EventSource、SSE 解析、重连、resume、后台
 * 完成、retry/cancel 全在共享 hook 里，本文件不复制流生命周期。
 */

export type InventoryInsightPanel = {
  state: InventoryPanelState
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

export type UseInventoryInsightOptions = {
  open: boolean
  scope: InventoryRunScope
  /** 测试注入：默认提交 canonical 库存域端点 */
  startRun?: DomainRunStarter<InventoryHealthRunInput>
  /** 测试注入；默认走 Next 代理下的 `/api/backend/v1/insight/runs` */
  client?: InsightClient
  reconnectDelayMs?: number
}

export function useInventoryInsight(options: UseInventoryInsightOptions): {
  panel: InventoryInsightPanel
  runId: string | null
  replayed: boolean
} {
  const { open, scope } = options
  const facts = useInsightDomainRun<InventoryHealthRunInput>({
    open,
    path: INVENTORY_HEALTH_RUN_PATH,
    input: toInventoryRunInput(scope),
    incompleteMessage: '请先选择项目',
    slot: INVENTORY_OUTPUT_SLOT,
    startRun: options.startRun,
    client: options.client,
    reconnectDelayMs: options.reconnectDelayMs,
  })

  const state = toInventoryPanelState({
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
