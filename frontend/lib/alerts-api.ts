/**
 * 告警中心 API 客户端。
 *
 * 全部走 Next.js 代理 `/api/backend/api/v1/alerts/*`，代理从 session cookie
 * 注入鉴权头，浏览器端 fetch 不需要手动带任何 header。
 */

const BASE = '/api/backend/api/v1/alerts'

// ── 类型 ────────────────────────────────────────────────

export interface AlertStats {
  total_active: number
  critical_count: number
  warning_count: number
  info_count: number
  acknowledged_today: number
  resolved_today: number
}

export interface AlertEventItem {
  id: number
  rule_id: number
  project_id: number
  metric: string
  current_value: number
  baseline_value: number
  deviation_pct: number
  severity: string
  message: string
  status: string
  triggered_at: string
  acknowledged_at: string | null
  acknowledged_by: string | null
}

export interface AlertEventListResponse {
  items: AlertEventItem[]
  total: number
  page: number
  page_size: number
}

export interface AlertRuleItem {
  id: number
  name: string
  project_id: number
  country: string
  metric: string
  trigger_type: string
  condition: string
  threshold: number
  window_days: number
  severity: string
  notification_channels: string
  is_active: boolean
  created_by: string
  created_at: string
  updated_at: string
}

export interface AlertRulePayload {
  name: string
  project_id: number
  country: string
  metric: string
  trigger_type: string
  condition: string
  threshold: number
  window_days: number
  severity: string
  notification_channels: string
}

export interface AlertPreference {
  email_enabled: boolean
  in_app_enabled: boolean
  min_severity: string
  quiet_hours_start: string | null
  quiet_hours_end: string | null
}

export interface MetricOption {
  value: string
  label: string
  description: string
}

export interface AlertEventsParams {
  status?: string
  severity?: string
  project_id?: number
  page: number
  page_size: number
}

// ── 查询串拼装（纯函数，可单测）─────────────────────────

export function buildEventsQuery(params: AlertEventsParams): string {
  const sp = new URLSearchParams()
  if (params.status) sp.set('status', params.status)
  if (params.severity) sp.set('severity', params.severity)
  if (params.project_id != null) sp.set('project_id', String(params.project_id))
  sp.set('page', String(params.page))
  sp.set('page_size', String(params.page_size))
  return sp.toString()
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    throw new Error(`Alerts API ${res.status}: ${await res.text()}`)
  }
  return res.json() as Promise<T>
}

// ── Stats ───────────────────────────────────────────────

export async function fetchAlertStats(projectId?: number): Promise<AlertStats> {
  const qs = projectId != null ? `?project_id=${projectId}` : ''
  const res = await fetch(`${BASE}/stats${qs}`)
  return jsonOrThrow<AlertStats>(res)
}

// ── Events ──────────────────────────────────────────────

export async function fetchAlertEvents(
  params: AlertEventsParams
): Promise<AlertEventListResponse> {
  const res = await fetch(`${BASE}/events?${buildEventsQuery(params)}`)
  return jsonOrThrow<AlertEventListResponse>(res)
}

export async function acknowledgeEvent(id: number): Promise<AlertEventItem> {
  const res = await fetch(`${BASE}/events/${id}/acknowledge`, { method: 'POST' })
  return jsonOrThrow<AlertEventItem>(res)
}

export async function resolveEvent(id: number): Promise<AlertEventItem> {
  const res = await fetch(`${BASE}/events/${id}/resolve`, { method: 'POST' })
  return jsonOrThrow<AlertEventItem>(res)
}

// ── Rules ───────────────────────────────────────────────

export async function fetchAlertRules(params?: {
  project_id?: number
  is_active?: boolean
}): Promise<AlertRuleItem[]> {
  const sp = new URLSearchParams()
  if (params?.project_id != null) sp.set('project_id', String(params.project_id))
  if (params?.is_active != null) sp.set('is_active', String(params.is_active))
  const qs = sp.toString()
  const res = await fetch(`${BASE}/rules${qs ? `?${qs}` : ''}`)
  return jsonOrThrow<AlertRuleItem[]>(res)
}

export async function createAlertRule(payload: AlertRulePayload): Promise<AlertRuleItem> {
  const res = await fetch(`${BASE}/rules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return jsonOrThrow<AlertRuleItem>(res)
}

export async function updateAlertRule(
  id: number,
  payload: Partial<AlertRulePayload> & { is_active?: boolean }
): Promise<AlertRuleItem> {
  const res = await fetch(`${BASE}/rules/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return jsonOrThrow<AlertRuleItem>(res)
}

export async function deleteAlertRule(id: number): Promise<void> {
  const res = await fetch(`${BASE}/rules/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`Delete rule ${res.status}: ${await res.text()}`)
}

// ── Metrics ─────────────────────────────────────────────

export async function fetchMetricOptions(): Promise<MetricOption[]> {
  const res = await fetch(`${BASE}/metrics`)
  const data = await jsonOrThrow<{ metrics: MetricOption[] }>(res)
  return data.metrics
}

// ── Preferences ─────────────────────────────────────────

export async function fetchAlertPreferences(): Promise<AlertPreference> {
  const res = await fetch(`${BASE}/preferences`)
  return jsonOrThrow<AlertPreference>(res)
}

export async function updateAlertPreferences(
  payload: Partial<AlertPreference>
): Promise<AlertPreference> {
  const res = await fetch(`${BASE}/preferences`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return jsonOrThrow<AlertPreference>(res)
}
