// ── 定时报告台账 → 共享 Insight UI 的纯映射层（BLF-1015）──
//
// 只做「台账领域事实 → 共享面板入参」的翻译：不 import React、不发请求、不碰
// Redis/DB/API key，也不把 frequency / 邮件状态之类的 schedule 概念塞进共享
// hook —— 共享层只认 canonical run 状态与 run id。
import type { InsightRunStatus, InsightStreamStatus } from '@/lib/insight/protocol'
import type { AiSummaryStatus, LedgerItem } from './types'

/**
 * 后端把 delivery_log 关联到 insight run 的绑定字段候选（BLF-1014 落地后回填
 * 其一）。两个名字都认，免得为一轮字段名谈判而卡住接线。
 */
const RUN_ID_FIELDS: readonly string[] = ['insight_run_id', 'run_id']

/** 从任意台账响应里读出 insight run 绑定；没有绑定返回 null。 */
export function readInsightRunId(source: unknown): string | null {
  if (typeof source !== 'object' || source === null || Array.isArray(source)) return null
  for (const [key, value] of Object.entries(source)) {
    if (!RUN_ID_FIELDS.includes(key)) continue
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

/** 台账条目上的 run 绑定；未绑定时为 null（此时面板退回服务端已落库的摘要）。 */
export function ledgerRunId(item: LedgerItem | null): string | null {
  const value = item?.insight_run_id
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** canonical run 状态 → 面板文案（只在真正拿到 run 时使用）。 */
export const LEDGER_RUN_LABELS: Record<InsightRunStatus, string> = {
  queued: '排队中',
  aggregating: '正在聚合数据',
  generating: '正在生成摘要',
  finalizing: '正在收尾',
  completed: 'AI 摘要已生成',
  failed: 'AI 摘要生成失败',
  cancelled: '已取消',
}

/** 后端已落库的 ai_summary_status → 面板文案（无 run 可接管时使用）。 */
const LEDGER_ITEM_LABELS: Record<AiSummaryStatus, string> = {
  pending: 'AI 摘要尚未生成',
  generating: 'AI 摘要生成中',
  done: 'AI 摘要已生成',
  failed: 'AI 摘要生成失败',
}

/** 落库状态 → canonical run 状态，用于让面板取对语义色（灰/转/绿/红）。 */
const ITEM_RUN_STATUS: Record<AiSummaryStatus, InsightRunStatus> = {
  pending: 'queued',
  generating: 'generating',
  done: 'completed',
  failed: 'failed',
}

/** run 是否仍在推进 —— 决定动作入口（取消 vs 重新生成）。 */
const ACTIVE_RUN_STATUS: Record<InsightRunStatus, boolean> = {
  queued: true,
  aggregating: true,
  generating: true,
  finalizing: true,
  completed: false,
  failed: false,
  cancelled: false,
}

/** 传输层仍在推流的状态；caret 只在真有流时闪。 */
const STREAMING_TRANSPORT: Record<string, true> = {
  queued: true,
  connecting: true,
  live: true,
  reconnecting: true,
}

/** canonical run 状态 → 台账列表沿用的 ai_summary_status 词表。 */
export function toLedgerSummaryStatus(status: InsightRunStatus): AiSummaryStatus {
  if (status === 'completed') return 'done'
  if (status === 'failed' || status === 'cancelled') return 'failed'
  return 'generating'
}

/** 历史摘要的项目符号 → Markdown 列表，保证渲染与旧版一致。 */
export function normalizeLedgerSummary(text: string): string {
  return text.replace(/^[•·●]\s*/gm, '- ')
}

/** 复制用文案：沿用旧版的 ◉ 前缀（粘贴到邮件/群聊的既有格式）。 */
export function ledgerCopyText(text: string): string {
  return text.replace(/^[-•·●]\s*/gm, '◉ ')
}

export type LedgerSummaryPanelState = {
  /** canonical 状态字符串，喂共享面板判色 */
  status: string
  label: string
  progress: number | null
  isStreaming: boolean
  /** 仍在推进：决定显示「取消」还是「重新生成」 */
  busy: boolean
}

/**
 * 台账事实 → 面板状态。有 run 绑定就用后端权威的 canonical 状态；没有绑定
 * 就退回落库的 ai_summary_status（历史记录、后端未回填绑定的场景）。
 */
export function toLedgerPanelState(input: {
  item: LedgerItem | null
  regenerating: boolean
  runStatus: InsightRunStatus | null
  transport: InsightStreamStatus
  progress: number | null
}): LedgerSummaryPanelState {
  if (input.runStatus) {
    return {
      status: input.runStatus,
      label: LEDGER_RUN_LABELS[input.runStatus],
      progress: input.progress,
      isStreaming: Object.prototype.hasOwnProperty.call(STREAMING_TRANSPORT, input.transport),
      busy: ACTIVE_RUN_STATUS[input.runStatus],
    }
  }

  const itemStatus = input.item?.ai_summary_status ?? 'pending'
  const generating = input.regenerating || itemStatus === 'generating'
  return {
    status: generating ? 'generating' : ITEM_RUN_STATUS[itemStatus],
    label: generating ? LEDGER_ITEM_LABELS.generating : LEDGER_ITEM_LABELS[itemStatus],
    progress: null,
    isStreaming: false,
    busy: generating,
  }
}

/**
 * 面板正文：run 的流式草稿优先，其次退回服务端已落库的摘要（历史记录仍可读）。
 * 只有落库摘要走项目符号归一化——流式内容是后端角色产出的 Markdown，其
 * content_sha256 对应的原文不能被改写。
 */
export function toLedgerPanelContent(input: {
  item: LedgerItem | null
  liveContent: string
  runSettled: boolean
}): { content: string; contentState: 'draft' | 'final' } {
  const live = input.liveContent ?? ''
  if (live.trim()) {
    return { content: live, contentState: input.runSettled ? 'final' : 'draft' }
  }
  const stored = input.item?.ai_summary
  if (stored && stored.trim()) {
    return { content: normalizeLedgerSummary(stored), contentState: 'final' }
  }
  return { content: '', contentState: 'final' }
}
