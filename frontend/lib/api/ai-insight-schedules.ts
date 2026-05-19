/**
 * AI Insight Schedule API Client
 * Frontend wrapper for /api/v1/ai-insights/schedules endpoints
 */

// Type definitions matching backend schemas
export interface InsightScheduleItem {
  id: number
  project_id: number
  project_name: string
  country: string
  insight_type: string
  cron_expression: string
  date_range_strategy: string
  model: string | null
  is_active: boolean
  run_count: number
  failure_count: number
  last_run_at: string | null
  last_insight_id: number | null
  last_error: string | null
  next_run_at: string | null
  created_by: string
  created_at: string
  updated_at: string
}

export interface InsightScheduleListResponse {
  items: InsightScheduleItem[]
  total: number
}

export interface InsightScheduleCreate {
  project_id: number
  country: 'US' | 'DE' | 'UK'
  insight_type: 'daily' | 'weekly' | 'monthly' | 'custom'
  cron_expression: string
  date_range_strategy: 'yesterday' | 'last_7d' | 'last_30d' | 'prev_month' | 'current_month' | 'last_week'
  model?: string | null
}

export interface ProjectOption {
  id: number
  name: string
}

export interface InsightScheduleUpdate {
  country?: 'US' | 'DE' | 'UK'
  insight_type?: 'daily' | 'weekly' | 'monthly' | 'custom'
  cron_expression?: string
  date_range_strategy?: 'yesterday' | 'last_7d' | 'last_30d' | 'prev_month' | 'current_month' | 'last_week'
  model?: string | null
  is_active?: boolean
}

export interface InsightScheduleToggleResponse {
  id: number
  is_active: boolean
  message: string
}

export interface InsightScheduleRunNowResponse {
  id: number
  insight_id: number
  status: string
  message: string
}

export interface InsightScheduleDeleteResponse {
  deleted: boolean
  id: number
}

// Cron presets for quick selection
export const CRON_PRESETS = [
  { label: '每天 06:00', value: '0 6 * * *' },
  { label: '每天 07:00', value: '0 7 * * *' },
  { label: '每天 08:00', value: '0 8 * * *' },
  { label: '每天 09:00', value: '0 9 * * *' },
  { label: '每周一 07:00', value: '0 7 * * 1' },
  { label: '每周一 08:00', value: '0 8 * * 1' },
  { label: '每月1号 07:00', value: '0 7 1 * *' },
  { label: '每月1号 08:00', value: '0 8 1 * *' },
] as const

// Date range strategy options
export const DATE_RANGE_STRATEGIES = [
  { value: 'yesterday', label: '昨日（单日）' },
  { value: 'last_7d', label: '近 7 天' },
  { value: 'last_30d', label: '近 30 天' },
  { value: 'prev_month', label: '上月整月' },
  { value: 'current_month', label: '当月至今' },
  { value: 'last_week', label: '上周（周一至周日）' },
] as const

// Country options
export const COUNTRY_OPTIONS = [
  { value: 'US', label: '美国站 (US)' },
  { value: 'DE', label: '德国站 (DE)' },
  { value: 'UK', label: '英国站 (UK)' },
] as const

// Insight type options
export const INSIGHT_TYPE_OPTIONS = [
  { value: 'daily', label: '日报' },
  { value: 'weekly', label: '周报' },
  { value: 'monthly', label: '月报' },
  { value: 'custom', label: '自定义' },
] as const

// Helper to parse cron expression into human-readable format
export function parseCronExpression(cron: string): string {
  const parts = cron.split(' ')
  if (parts.length !== 5) return cron

  const [minute, hour, day, month, dayOfWeek] = parts

  // Daily at specific hour
  if (day === '*' && month === '*' && dayOfWeek === '*') {
    return `每天 ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
  }

  // Weekly on specific day
  if (day === '*' && month === '*' && dayOfWeek !== '*') {
    const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    const dayIndex = parseInt(dayOfWeek) || 0
    return `每周${days[dayIndex % 7]} ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
  }

  // Monthly on specific day
  if (day !== '*' && month === '*' && dayOfWeek === '*') {
    return `每月 ${day} 日 ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
  }

  return cron
}

// Format date for display
export function formatDateTime(dateStr: string | null): string {
  if (!dateStr) return '—'
  const date = new Date(dateStr)
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// Format relative time (e.g., "3 分钟前")
export function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return '—'
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)

  if (diffMins < 1) return '刚刚'
  if (diffMins < 60) return `${diffMins} 分钟前`
  if (diffMins < 1440) return `${Math.floor(diffMins / 60)} 小时前`
  if (diffMins < 10080) return `${Math.floor(diffMins / 1440)} 天前`
  return formatDateTime(dateStr)
}

// API functions
async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const error = await res.text()
    throw new Error(error || `Request failed: ${res.status}`)
  }
  return res.json() as Promise<T>
}

export async function getSchedules(params?: {
  project_id?: number
  is_active?: boolean
}): Promise<InsightScheduleItem[]> {
  const searchParams = new URLSearchParams()
  if (params?.project_id) searchParams.set('project_id', params.project_id.toString())
  if (params?.is_active !== undefined) searchParams.set('is_active', params.is_active.toString())

  const query = searchParams.toString()
  const res = await fetch(`/api/backend/v1/ai-insights/schedules${query ? `?${query}` : ''}`)
  const data = await handleResponse<InsightScheduleListResponse>(res)
  return data.items
}

export async function createSchedule(data: InsightScheduleCreate): Promise<InsightScheduleItem> {
  const res = await fetch('/api/backend/v1/ai-insights/schedules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return handleResponse<InsightScheduleItem>(res)
}

export async function updateSchedule(id: number, data: InsightScheduleUpdate): Promise<InsightScheduleItem> {
  const res = await fetch(`/api/backend/v1/ai-insights/schedules/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return handleResponse<InsightScheduleItem>(res)
}

export async function deleteSchedule(id: number): Promise<InsightScheduleDeleteResponse> {
  const res = await fetch(`/api/backend/v1/ai-insights/schedules/${id}`, {
    method: 'DELETE',
  })
  return handleResponse<InsightScheduleDeleteResponse>(res)
}

export async function toggleSchedule(id: number): Promise<InsightScheduleToggleResponse> {
  const res = await fetch(`/api/backend/v1/ai-insights/schedules/${id}/toggle`, {
    method: 'POST',
  })
  return handleResponse<InsightScheduleToggleResponse>(res)
}

export async function runScheduleNow(id: number): Promise<InsightScheduleRunNowResponse> {
  const res = await fetch(`/api/backend/v1/ai-insights/schedules/${id}/run-now`, {
    method: 'POST',
  })
  return handleResponse<InsightScheduleRunNowResponse>(res)
}