/**
 * 旧洞察（`/ai-insights/*`）兼容 adapter —— 纯映射层，无 React、无网络、无 EventSource。
 *
 * BLF-1017：旧洞察页（`/dashboard/ai/insights`）从「自带一套流状态机」降级为
 * **兼容 adapter**——只保留历史数据查看 + 域数据展示（renderer），流状态一律
 * 由共享 hook（`useInsightStream`）/ 兼容订阅 hook（`use-legacy-insight-stream`）
 * 持有。本文件负责把旧后端的 SSE 帧与 `status` / `sub_status` 词表翻译成共享
 * `InsightStreamPanel` 需要的 canonical 语义，避免这层翻译散落进组件。
 *
 * 旧后端事实（`backend/app/api/v1/endpoints/ai_insight.py::stream_insight`）：
 * 每 2s 轮询 DB，只在状态变化时发 `status` 帧、其余发 `ping`，终态发一次
 * `done` / `error`；正文只在终态帧里带回来（不存在真实的分片 `chunk` 帧，
 * `chunk` 仅作向后兼容处理）。因此本 adapter 不做进度百分比，用 steps 步进器
 * 表达阶段。
 */

import type { InsightErrorPayload } from '@/lib/insight'

/** 旧后端 SSE 帧（`data:` 里的 JSON），只保留实际消费的字段。 */
export type LegacyInsightFrame =
  | {
      type: 'status'
      status: string
      sub_status?: string | null
      insight_id?: number
      title?: string
      content?: string
      error_message?: string | null
    }
  | { type: 'chunk'; delta: string }
  | {
      type: 'done'
      insight_id?: number
      title?: string
      content?: string
      status?: string
      error_message?: string | null
    }
  | {
      type: 'error'
      error: string
      insight_id?: number | null
      status?: string
      error_message?: string | null
    }
  | { type: 'ping' }

const FRAME_TYPES = ['status', 'chunk', 'done', 'error', 'ping'] as const

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' ? value : undefined
}

function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readNullableString(source: Record<string, unknown>, key: string): string | null | undefined {
  const value = source[key]
  if (value === null) return null
  return typeof value === 'string' ? value : undefined
}

/** 旧 sub_status → 人话标签（表格、步进器、面板状态行共用）。 */
export const LEGACY_SUB_STATUS_LABELS: Record<string, string> = {
  queued: '排队中...',
  data_aggregating: '正在聚合数据...',
  data_aggregating_sales: '抓取销售数据...',
  data_aggregating_ad: '抓取广告数据...',
  data_aggregating_inventory: '抓取库存数据...',
  data_aggregating_comparison_sales: '抓取对比期销售...',
  data_aggregating_comparison_ad: '抓取对比期广告...',
  data_aggregating_top_skus: '抓取 Top SKU...',
  data_aggregating_ad_campaigns: '抓取广告活动...',
  ai_generating: '正在生成洞察...',
  title_generating: '正在生成标题...',
}

/**
 * 解析一帧旧 SSE `data` 载荷。非法载荷返回 null（不抛，避免污染消费端）。
 * 逐字段校验后重建帧对象——旧流的帧结构由后端直接 JSON 序列化，不做二次断言。
 */
export function parseLegacyInsightFrame(data: string): LegacyInsightFrame | null {
  const trimmed = data.trim()
  if (!trimmed) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const source = parsed as Record<string, unknown>
  const type = source.type
  if (typeof type !== 'string') return null

  const insightId = readNumber(source, 'insight_id')
  const title = readString(source, 'title')
  const content = readString(source, 'content')
  const status = readString(source, 'status')
  const errorMessage = readNullableString(source, 'error_message')
  const subStatus = readNullableString(source, 'sub_status')

  switch (type) {
    case 'status': {
      if (!status) return null
      return {
        type: 'status',
        status,
        ...(subStatus === undefined ? {} : { sub_status: subStatus }),
        ...(insightId === undefined ? {} : { insight_id: insightId }),
        ...(title === undefined ? {} : { title }),
        ...(content === undefined ? {} : { content }),
        ...(errorMessage === undefined ? {} : { error_message: errorMessage }),
      }
    }
    case 'chunk': {
      const delta = readString(source, 'delta')
      return delta === undefined ? null : { type: 'chunk', delta }
    }
    case 'done':
      return {
        type: 'done',
        ...(insightId === undefined ? {} : { insight_id: insightId }),
        ...(title === undefined ? {} : { title }),
        ...(content === undefined ? {} : { content }),
        ...(status === undefined ? {} : { status }),
        ...(errorMessage === undefined ? {} : { error_message: errorMessage }),
      }
    case 'error': {
      const error = readString(source, 'error')
      return {
        type: 'error',
        error: error ?? errorMessage ?? '洞察生成失败',
        ...(insightId === undefined ? {} : { insight_id: insightId }),
        ...(status === undefined ? {} : { status }),
        ...(errorMessage === undefined ? {} : { error_message: errorMessage }),
      }
    }
    case 'ping':
      return { type: 'ping' }
    default:
      return null
  }
}

/** 从帧里取 sub_status 的推进（`pending` 归一为 `queued`；无推进返回 null）。 */
export function legacyFrameSubStatus(frame: LegacyInsightFrame): string | null {
  if (frame.type !== 'status') return null
  if (frame.sub_status) return frame.sub_status
  if (frame.status === 'pending') return 'queued'
  return null
}

/** 旧 run 的终态判定：status 词表是 `pending | generating | completed | failed`。 */
export function isLegacyTerminalStatus(status: string | null | undefined): boolean {
  return status === 'completed' || status === 'failed'
}

export type LegacyRunTransport = 'idle' | 'live' | 'reconnecting' | 'ended'

export type LegacyPanelState = {
  /** canonical 状态字符串（交给 `InsightStatus` 决策色板与图标） */
  status: string
  label: string
  busy: boolean
  isStreaming: boolean
  contentState: 'draft' | 'final'
}

/**
 * 把旧 `status` + `sub_status` + 传输态翻译成面板状态。
 * 未知 `sub_status` 按「聚合中」兜底展示，不丢信息（正文里仍可见原文）。
 */
export function toLegacyPanelState(input: {
  status: 'idle' | 'running' | 'completed' | 'failed'
  subStatus: string | null
  transport: LegacyRunTransport
}): LegacyPanelState {
  const { status, subStatus, transport } = input
  if (status === 'completed') {
    return { status: 'completed', label: '生成完成', busy: false, isStreaming: false, contentState: 'final' }
  }
  if (status === 'failed') {
    return { status: 'failed', label: '生成失败', busy: false, isStreaming: false, contentState: 'final' }
  }
  if (status === 'idle') {
    return { status: 'queued', label: '等待开始', busy: false, isStreaming: false, contentState: 'draft' }
  }
  if (transport === 'reconnecting') {
    return {
      status: 'reconnecting',
      label: '连接中断，正在重连',
      busy: true,
      isStreaming: false,
      contentState: 'draft',
    }
  }
  const label = subStatus ? (LEGACY_SUB_STATUS_LABELS[subStatus] ?? '正在聚合数据...') : '正在生成洞察...'
  const canonical = legacySubStatusToCanonical(subStatus)
  return { status: canonical, label, busy: true, isStreaming: true, contentState: 'draft' }
}

function legacySubStatusToCanonical(subStatus: string | null): string {
  if (!subStatus) return 'generating'
  if (subStatus === 'queued') return 'queued'
  if (subStatus === 'ai_generating') return 'generating'
  if (subStatus === 'title_generating') return 'finalizing'
  if (subStatus.startsWith('data_aggregating')) return 'aggregating'
  return 'generating'
}

/** 旧流错误 / 中断文案 → 共享面板的 error 载荷。 */
export function toLegacyPanelError(message: string | null): InsightErrorPayload | null {
  if (!message) return null
  return { code: 'LEGACY_STREAM_ERROR', message, retryable: true }
}
