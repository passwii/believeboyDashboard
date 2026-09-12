// ── 库存健康 → 共享 Insight UI 的纯映射层（BLF-1017）──
//
// 只做「库存域事实 → 共享面板入参」的翻译：不 import React、不发请求、不碰
// EventSource/SSE，也不持有 provider/retry 状态。库存口径与广告不同：单日快照
// （`report_date` 可缺省 = 最新快照日），不是日期区间。
import type { InventoryHealthRunInput } from '@/lib/insight/domain-runs'
import type { InsightRunStatus, InsightStreamStatus } from '@/lib/insight/protocol'

/** canonical inventory role 的输出槽（`roles.py`: `inventory_health.v1` output_slot）。 */
export const INVENTORY_OUTPUT_SLOT = 'main'

/** 口径日缺省时的说明：后端按最新库存快照口径分析。 */
export const INVENTORY_LATEST_SNAPSHOT_HINT = '不指定口径日 = 按最新库存快照分析'

/** canonical run 状态 → 库存域文案。 */
export const INVENTORY_RUN_LABELS: Record<InsightRunStatus, string> = {
  queued: '排队中',
  aggregating: '正在聚合库存与补货数据',
  generating: '正在生成库存健康分析',
  finalizing: '正在收尾',
  completed: '库存健康分析已完成',
  failed: '库存健康分析生成失败',
  cancelled: '已取消',
}

/** 传输层状态 → 库存域文案（run 状态未知或断流重连时使用）。 */
const INVENTORY_TRANSPORT_LABELS: Record<InsightStreamStatus, string> = {
  queued: '准备提交分析任务',
  connecting: '正在连接生成流',
  live: '正在生成库存健康分析',
  reconnecting: '连接中断，正在重连',
  aggregating: '正在聚合库存与补货数据',
  generating: '正在生成库存健康分析',
  finalizing: '正在收尾',
  completed: '库存健康分析已完成',
  failed: '库存健康分析生成失败',
  cancelled: '已取消',
}

/** run 是否仍在推进 —— 决定面板给「取消」还是「重试」。 */
const INVENTORY_ACTIVE_RUN: Record<InsightRunStatus, boolean> = {
  queued: true,
  aggregating: true,
  generating: true,
  finalizing: true,
  completed: false,
  failed: false,
  cancelled: false,
}

export type InventoryRunScope = {
  projectId: number | null
  country: string
  /** 口径日；null = 最新快照口径 */
  reportDate?: Date | null
}

function formatYMD(date: Date | null | undefined): string {
  if (!date) return ''
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 展示用口径文案：`US · 2026-09-11`；未指定口径日时显示「最新快照」。 */
export function inventoryScopeLabel(scope: InventoryRunScope): string {
  const reportDate = formatYMD(scope.reportDate)
  return [scope.country, reportDate || '最新快照'].filter(Boolean).join(' · ')
}

/** 页面口径 → 域端点请求体；未选项目返回 null（站点恒有默认值）。 */
export function toInventoryRunInput(
  scope: InventoryRunScope
): InventoryHealthRunInput | null {
  if (!scope.projectId) return null
  const reportDate = formatYMD(scope.reportDate)
  return {
    project_id: scope.projectId,
    country: scope.country,
    ...(reportDate ? { report_date: reportDate } : {}),
  }
}

export type InventoryPanelState = {
  /** 喂共享面板判色的 canonical 状态字符串 */
  status: string
  label: string
  progress: number | null
  isStreaming: boolean
  /** 仍在推进：决定显示「取消」还是「重试」 */
  busy: boolean
}

/**
 * 库存 run 事实 → 面板状态。
 *
 * run 状态（后端权威）优先于传输层状态：断流重连期间 run 可能已经完成，此时
 * 以 `runStatus` 为准；只有拿不到 run 状态时才退到传输层文案。
 */
export function toInventoryPanelState(input: {
  runStatus: InsightRunStatus | null
  transport: InsightStreamStatus
  progress: number | null
}): InventoryPanelState {
  const { runStatus, transport, progress } = input
  if (!runStatus) {
    return {
      status: transport,
      label: INVENTORY_TRANSPORT_LABELS[transport],
      progress: null,
      // 只有真的在推增量时才有光标；connecting / reconnecting 期间没有内容在动。
      isStreaming: transport === 'live',
      busy: true,
    }
  }
  const reconnecting = INVENTORY_ACTIVE_RUN[runStatus] && transport === 'reconnecting'
  return {
    status: runStatus,
    label: reconnecting ? INVENTORY_TRANSPORT_LABELS.reconnecting : INVENTORY_RUN_LABELS[runStatus],
    progress: INVENTORY_ACTIVE_RUN[runStatus] ? progress : null,
    isStreaming: INVENTORY_ACTIVE_RUN[runStatus] && transport === 'live',
    busy: INVENTORY_ACTIVE_RUN[runStatus],
  }
}
