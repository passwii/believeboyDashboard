export const INSIGHT_SCHEMA_VERSION = 1 as const

/** canonical run 状态（后端 `InsightStatus`，权威）。 */
export type InsightRunStatus =
  | 'queued'
  | 'aggregating'
  | 'generating'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** run 阶段（后端 `InsightStage`），是 status 的子集。 */
export type InsightRunStage = 'queued' | 'aggregating' | 'generating' | 'finalizing'

/** 前端 stream 订阅的**传输层**状态，不是 run 状态。 */
export type InsightStreamStatus =
  | InsightRunStatus
  | 'connecting'
  | 'live'
  | 'reconnecting'

export type InsightCountry = 'US' | 'DE' | 'UK'

export type InsightSlots = Record<string, unknown>

/** 归一化后的输出：slot → Markdown 正文。 */
export type InsightOutputs = Record<string, string>

/** wire 上的输出 slot：canonical 契约里是对象，不是裸字符串。 */
export type InsightOutput = {
  format?: string
  content: string
  content_sha256?: string
}

export type InsightRawOutputs = Record<string, InsightOutput | string>

/**
 * canonical 创建 run 请求（对齐 `types/api-generated/insight-contract.json`
 * 的 `schemas.InsightRunRequest`）。字段名/必填与后端 Pydantic 模型一致，
 * 额外字段会被后端以 `INVALID_REQUEST` 拒绝。
 */
export type InsightRunRequest = {
  schema_version: number
  role_id: string
  role_version: number
  project_id: number
  country: InsightCountry
  slots: InsightSlots
  idempotency_key: string
  client_request_id?: string
  endpoint_id?: string
  model_id?: string
}

export type InsightErrorPayload = {
  code: string
  message: string
  retryable?: boolean
  retry_after_seconds?: number | null
  partial_available?: boolean
  field?: string | null
  slot?: string | null
  details?: Record<string, unknown>
}

export type InsightSnapshot = {
  outputs: InsightOutputs
  [key: string]: unknown
}

/** canonical detail 的可恢复性描述。 */
export type InsightResumeInfo = {
  latest_event_id?: string | null
  current_attempt: number
  history_available: boolean
}

type InsightEventBase = {
  schema_version: number
  run_id: string
  attempt: number
  seq: number
}

export type InsightSnapshotEvent = InsightEventBase & {
  type: 'snapshot'
  status?: string
  stage?: string
  progress_percent?: number
  outputs?: InsightRawOutputs
  is_terminal?: boolean
  error?: InsightErrorPayload | null
  /** 旧前端协议的嵌套快照形态，仅作向后兼容读取 */
  snapshot?: InsightSnapshot
}

export type InsightStatusEvent = InsightEventBase & {
  type: 'status'
  status: string
  stage?: string
  progress_percent?: number
  detail?: string | null
}

export type InsightContentDeltaEvent = InsightEventBase & {
  type: 'content.delta'
  slot: string
  block_id?: string
  format?: string
  delta: string
}

export type InsightContentSnapshotEvent = InsightEventBase & {
  type: 'content.snapshot'
  slot?: string
  format?: string
  content?: string
  content_sha256?: string
  checkpoint_seq?: number
  snapshot?: InsightSnapshot
}

export type InsightDoneEvent = InsightEventBase & {
  type: 'done'
  status?: 'completed'
  outputs?: InsightRawOutputs
  artifact_id?: string | null
  title?: string | null
  content_sha256?: string
  usage?: Record<string, number> | null
  snapshot?: InsightSnapshot
}

export type InsightErrorEvent = InsightEventBase & {
  type: 'error'
  /** 终态原因：`failed` 或 `cancelled` */
  status?: 'failed' | 'cancelled'
  error: InsightErrorPayload
}

export type InsightPingEvent = InsightEventBase & {
  type: 'ping'
}

export type InsightKnownEvent =
  | InsightSnapshotEvent
  | InsightStatusEvent
  | InsightContentDeltaEvent
  | InsightContentSnapshotEvent
  | InsightDoneEvent
  | InsightErrorEvent
  | InsightPingEvent

export type InsightUnknownEvent = {
  type: string
  [key: string]: unknown
}

export type InsightEvent = InsightKnownEvent | InsightUnknownEvent

export type InsightRunStartResponse = {
  schema_version?: number
  run_id: string
  attempt: number
  role_id?: string
  role_version?: number
  project_id?: number
  country?: string
  status: string
  output_format?: string
  detail_url?: string
  stream_url?: string
  cancel_url?: string
  retry_url?: string
  replayed?: boolean
  created_at?: string
  updated_at?: string
}

/** cancel / retry 动作响应（canonical `InsightRunActionResponse`）。 */
export type InsightRunActionResponse = {
  schema_version?: number
  run_id: string
  attempt: number
  status: string
  detail_url?: string
  stream_url?: string
  replayed?: boolean
}

/** 权威 detail：页面重开、断流、后台完成后都靠它恢复。 */
export type InsightRunDetail = InsightRunStartResponse & {
  stage?: string
  progress_percent?: number
  title?: string | null
  outputs?: InsightRawOutputs
  artifact_id?: string | null
  error?: InsightErrorPayload | null
  resume?: InsightResumeInfo
  completed_at?: string | null
}

export function isInsightEvent(value: unknown): value is InsightEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if (!('type' in value)) return false
  return typeof value.type === 'string'
}

export function isInsightEventType<T extends InsightKnownEvent['type']>(
  value: InsightEvent,
  type: T
): value is Extract<InsightKnownEvent, { type: T }> {
  return value.type === type
}

export function isInsightErrorPayload(value: unknown): value is InsightErrorPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if (!('code' in value) || !('message' in value)) return false
  return typeof value.code === 'string' && typeof value.message === 'string'
}

export function isInsightRunStartResponse(value: unknown): value is InsightRunStartResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if (!('run_id' in value) || !('status' in value) || !('attempt' in value)) return false
  return (
    typeof value.run_id === 'string' &&
    typeof value.status === 'string' &&
    typeof value.attempt === 'number'
  )
}

export function isInsightRunDetail(value: unknown): value is InsightRunDetail {
  return isInsightRunStartResponse(value)
}

/**
 * 归一化 wire 上的 outputs：canonical 是 `{slot: {format, content, content_sha256}}`，
 * 旧形态是 `{slot: "markdown"}`。两种都接受，统一收敛成 `{slot: content}`，
 * 内容为空的 slot 直接丢弃（避免用空串覆盖已有草稿）。
 */
export function normalizeInsightOutputs(outputs: unknown): InsightOutputs {
  if (typeof outputs !== 'object' || outputs === null || Array.isArray(outputs)) return {}
  const normalized: InsightOutputs = {}
  for (const [slot, output] of Object.entries(outputs)) {
    if (typeof output === 'string') {
      if (output.length > 0) normalized[slot] = output
      continue
    }
    if (typeof output !== 'object' || output === null || Array.isArray(output)) continue
    if (!('content' in output)) continue
    const content = output.content
    if (typeof content === 'string' && content.length > 0) normalized[slot] = content
  }
  return normalized
}

export function getInsightOutputs(value: unknown): InsightOutputs | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  if (!('outputs' in value)) return null
  return normalizeInsightOutputs(value.outputs)
}

export function getInsightSnapshot(value: unknown): InsightSnapshot | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  if (!('snapshot' in value)) return null
  const snapshot = value.snapshot
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) return null

  const outputs = getInsightOutputs(snapshot) ?? {}
  const normalized: InsightSnapshot = { outputs }
  for (const [key, candidate] of Object.entries(snapshot)) {
    if (key !== 'outputs') normalized[key] = candidate
  }
  return normalized
}
