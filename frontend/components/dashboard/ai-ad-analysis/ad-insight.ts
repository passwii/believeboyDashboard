// ── AI 广告分析 → 共享 Insight UI 的纯映射层（BLF-1017）──
//
// 只做「广告分析领域事实 → 共享面板入参」的翻译：不 import React、不发请求、
// 不碰 EventSource/SSE，也不持有 provider/retry 状态——那些全在
// `useInsightStream` 与 `InsightStreamPanel` 里，本模块只保证广告域的口径
// （canonical `ad_analysis.v1`：单轮生成，输出槽固定 `main`）映射正确。
import type { AdAnalysisRunInput } from '@/lib/insight/domain-runs'
import type { InsightRunStatus, InsightStreamStatus } from '@/lib/insight/protocol'

/** canonical ad role 的输出槽（`roles.py`: `ad_analysis.v1` output_slot）。 */
export const AD_OUTPUT_SLOT = 'main'

/** canonical run 状态 → 广告域文案。 */
export const AD_RUN_LABELS: Record<InsightRunStatus, string> = {
  queued: '排队中',
  aggregating: '正在聚合广告数据',
  generating: '正在生成广告分析',
  finalizing: '正在收尾',
  completed: '广告分析已完成',
  failed: '广告分析生成失败',
  cancelled: '已取消',
}

/** 传输层状态 → 广告域文案（run 状态未知或断流重连时使用）。 */
const AD_TRANSPORT_LABELS: Record<InsightStreamStatus, string> = {
  queued: '准备提交分析任务',
  connecting: '正在连接生成流',
  live: '正在生成广告分析',
  reconnecting: '连接中断，正在重连',
  aggregating: '正在聚合广告数据',
  generating: '正在生成广告分析',
  finalizing: '正在收尾',
  completed: '广告分析已完成',
  failed: '广告分析生成失败',
  cancelled: '已取消',
}

/** run 是否仍在推进 —— 决定面板给「取消」还是「重试」。 */
const AD_ACTIVE_RUN: Record<InsightRunStatus, boolean> = {
  queued: true,
  aggregating: true,
  generating: true,
  finalizing: true,
  completed: false,
  failed: false,
  cancelled: false,
}

export type AdRunScope = {
  projectId: number | null
  country: string
  from?: Date | null
  to?: Date | null
}

function formatYMD(date: Date | null | undefined): string {
  if (!date) return ''
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 展示用口径文案：`US · 2026-09-01 ~ 2026-09-07`（缺哪段省哪段）。 */
export function adScopeLabel(scope: AdRunScope): string {
  const range = [formatYMD(scope.from), formatYMD(scope.to)].filter(Boolean).join(' ~ ')
  return [scope.country, range].filter(Boolean).join(' · ')
}

/** 页面口径 → 域端点请求体；口径不全（未选项目/日期）返回 null。 */
export function toAdRunInput(scope: AdRunScope): AdAnalysisRunInput | null {
  if (!scope.projectId) return null
  const startDate = formatYMD(scope.from)
  const endDate = formatYMD(scope.to)
  if (!startDate || !endDate) return null
  return {
    project_id: scope.projectId,
    country: scope.country,
    start_date: startDate,
    end_date: endDate,
  }
}

export type AdPanelState = {
  /** 喂共享面板判色的 canonical 状态字符串 */
  status: string
  label: string
  progress: number | null
  isStreaming: boolean
  /** 仍在推进：决定显示「取消」还是「重试」 */
  busy: boolean
}

/**
 * 广告 run 事实 → 面板状态。
 *
 * run 状态（后端权威）优先于传输层状态：断流重连期间 run 可能已经完成，此时
 * 以 `runStatus` 为准；只有拿不到 run 状态时才退到传输层文案。
 */
export function toAdPanelState(input: {
  runStatus: InsightRunStatus | null
  transport: InsightStreamStatus
  progress: number | null
}): AdPanelState {
  const { runStatus, transport, progress } = input
  if (!runStatus) {
    return {
      status: transport,
      label: AD_TRANSPORT_LABELS[transport],
      progress: null,
      // 只有真的在推增量时才有光标；connecting / reconnecting 期间没有内容在动。
      isStreaming: transport === 'live',
      busy: true,
    }
  }
  const reconnecting = !AD_ACTIVE_RUN[runStatus] ? false : transport === 'reconnecting'
  return {
    status: runStatus,
    label: reconnecting ? AD_TRANSPORT_LABELS.reconnecting : AD_RUN_LABELS[runStatus],
    progress: AD_ACTIVE_RUN[runStatus] ? progress : null,
    isStreaming: AD_ACTIVE_RUN[runStatus] && transport === 'live',
    busy: AD_ACTIVE_RUN[runStatus],
  }
}
