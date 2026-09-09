export const INSIGHT_SCHEMA_VERSION = 1 as const

export type InsightRunStatus =
  | 'queued'
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'aggregating'
  | 'running'
  | 'generating'
  | 'finalizing'

export type InsightScope = {
  project_id?: number
  country?: string
}

export type InsightSlots = Record<string, unknown>
export type InsightOutputs = Record<string, string>

export type InsightRunRequest = {
  capability: string
  role: string
  use_case?: string
  scope?: InsightScope
  slots?: InsightSlots
  model?: string
  idempotency_key?: string
}

export type InsightErrorPayload = {
  code: string
  message: string
  retryable?: boolean
  retry_after?: number | null
  details?: Record<string, unknown>
}

export type InsightSnapshot = {
  outputs: InsightOutputs
  [key: string]: unknown
}

type InsightEventBase = {
  schema_version: number
  run_id: string
  attempt: number
  seq: number
}

export type InsightSnapshotEvent = InsightEventBase & {
  type: 'snapshot'
  snapshot?: InsightSnapshot
  outputs?: InsightOutputs
}

export type InsightStatusEvent = InsightEventBase & {
  type: 'status'
  status: string
  sub_status?: string | null
  progress?: number | null
}

export type InsightContentDeltaEvent = InsightEventBase & {
  type: 'content.delta'
  slot: string
  delta: string
}

export type InsightContentSnapshotEvent = InsightEventBase & {
  type: 'content.snapshot'
  slot?: string
  content?: string
  snapshot?: InsightSnapshot
  outputs?: InsightOutputs
}

export type InsightDoneEvent = InsightEventBase & {
  type: 'done'
  outputs?: InsightOutputs
  snapshot?: InsightSnapshot
  duration_ms?: number | null
}

export type InsightErrorEvent = InsightEventBase & {
  type: 'error'
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
  run_id: string
  status: string
  attempt: number
  schema_version?: number
  snapshot?: InsightSnapshot | null
}

export type InsightRunDetail = InsightRunStartResponse & {
  capability?: string
  use_case?: string
  role?: string
  scope?: InsightScope
  outputs?: InsightOutputs
  content?: string | null
  error?: InsightErrorPayload | null
  created_at?: string
  updated_at?: string
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

export function getInsightOutputs(value: unknown): InsightOutputs | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  if (!('outputs' in value)) return null
  const outputs = value.outputs
  if (typeof outputs !== 'object' || outputs === null || Array.isArray(outputs)) return null

  const normalized: InsightOutputs = {}
  for (const [slot, output] of Object.entries(outputs)) {
    if (typeof output === 'string') normalized[slot] = output
  }
  return normalized
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
