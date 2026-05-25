const API_BASE = '/api/backend'

function resolveApiUrl(path: string) {
  const base = API_BASE.endsWith('/') ? API_BASE.slice(0, -1) : API_BASE
  return `${base}${path}`
}

// ============================================================================
// Types
// ============================================================================

export interface HealthData {
  account_health_rating?: string
  odr?: number
  late_shipment_rate?: number
  pre_fulfillment_cancel_rate?: number
  valid_tracking_rate?: number
  on_time_delivery_rate?: number
}

export interface ComplianceData {
  policy_violations?: number
  ip_complaints?: number
  restricted_product_warnings?: number
  listing_suppressed_count?: number
  account_deactivation_risk?: boolean
}

export interface InspectionTemplateField {
  key: string
  label: string
  label_en: string
  type: string
  unit?: string
  options?: string[]
  threshold_warning?: number
  threshold_critical?: number
  threshold_direction?: string
}

export interface InspectionTemplate {
  health_fields: InspectionTemplateField[]
  compliance_fields: InspectionTemplateField[]
}

export interface InspectionPeriod {
  id: number
  week_start: string
  week_end: string
  deadline: string
  created_at: string
}

export interface InspectionScreenshot {
  id: number
  r2_key: string
  filename: string
  content_type: string
  file_size: number
  caption?: string
  sort_order: number
  url: string
  thumbnail_url?: string
  created_at: string
}

export interface InspectionReport {
  id: number
  period_id: number
  project_id: number
  status: 'draft' | 'submitted' | 'overdue'
  health_data: HealthData | null
  compliance_data: ComplianceData | null
  status_summary?: string
  submitted_by?: string
  submitted_at?: string
  screenshots: InspectionScreenshot[]
  created_at: string
  updated_at: string
}

export interface InspectionOverviewItem {
  project_id: number
  project_name: string
  status: 'submitted' | 'draft' | 'overdue' | 'pending'
  account_health_rating?: string
  odr?: number
  late_shipment_rate?: number
  valid_tracking_rate?: number
  policy_violations?: number
  account_deactivation_risk?: boolean
  status_summary?: string
  submitted_by?: string
  submitted_at?: string
  screenshots?: {
    id: number
    url: string
    thumbnail_url?: string
    caption?: string
  }[]
}

export interface InspectionOverview {
  period: InspectionPeriod
  items: InspectionOverviewItem[]
  total_projects: number
  submitted_count: number
  overdue_count: number
}

export interface InspectionHistoryItem {
  id: number
  period_id: number
  week_start: string
  week_end: string
  project_id: number
  project_name: string
  status: string
  account_health_rating?: string
  odr?: number
  submitted_by?: string
  submitted_at?: string
}

export interface InspectionHistoryResponse {
  items: InspectionHistoryItem[]
  total: number
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Fetch inspection template configuration
 */
export async function fetchInspectionTemplate(): Promise<InspectionTemplate> {
  const res = await fetch(resolveApiUrl('/api/v1/inspections/template'))
  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: '获取巡检模板失败' })) as { detail?: string }
    throw new Error(error.detail || '获取巡检模板失败')
  }
  return res.json() as Promise<InspectionTemplate>
}

/**
 * Fetch current inspection period
 */
export async function fetchCurrentPeriod(): Promise<InspectionPeriod> {
  const res = await fetch(resolveApiUrl('/api/v1/inspections/periods/current'))
  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: '获取当前巡检周期失败' })) as { detail?: string }
    throw new Error(error.detail || '获取当前巡检周期失败')
  }
  return res.json() as Promise<InspectionPeriod>
}

/**
 * Fetch inspection periods with pagination
 */
export async function fetchPeriods(limit?: number, offset?: number): Promise<{ items: InspectionPeriod[]; total: number }> {
  const params = new URLSearchParams()
  if (limit !== undefined) params.set('limit', String(limit))
  if (offset !== undefined) params.set('offset', String(offset))

  const query = params.toString()
  const url = resolveApiUrl('/api/v1/inspections/periods') + (query ? `?${query}` : '')

  const res = await fetch(url)
  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: '获取巡检周期列表失败' })) as { detail?: string }
    throw new Error(error.detail || '获取巡检周期列表失败')
  }
  return res.json() as Promise<{ items: InspectionPeriod[]; total: number }>
}

/**
 * Fetch inspection overview for a specific period
 */
export async function fetchPeriodOverview(periodId: number): Promise<InspectionOverview> {
  const res = await fetch(resolveApiUrl(`/api/v1/inspections/periods/${periodId}/overview`))
  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: '获取巡检概览失败' })) as { detail?: string }
    throw new Error(error.detail || '获取巡检概览失败')
  }
  return res.json() as Promise<InspectionOverview>
}

/**
 * Fetch inspection report for a specific period and project
 */
export async function fetchReport(periodId: number, projectId: number): Promise<InspectionReport | null> {
  const res = await fetch(resolveApiUrl(`/api/v1/inspections/periods/${periodId}/projects/${projectId}`))
  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: '获取巡检报告失败' })) as { detail?: string }
    throw new Error(error.detail || '获取巡检报告失败')
  }
  if (res.status === 204 || res.headers.get('content-length') === '0') {
    return null
  }
  return res.json() as Promise<InspectionReport | null>
}

interface SaveReportPayload {
  health_data?: HealthData
  compliance_data?: ComplianceData
  status_summary?: string
  screenshot_ids?: number[]
}

/**
 * Save inspection report for a specific period and project
 */
export async function saveReport(
  periodId: number,
  projectId: number,
  data: SaveReportPayload
): Promise<InspectionReport> {
  const res = await fetch(resolveApiUrl(`/api/v1/inspections/periods/${periodId}/projects/${projectId}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: '保存巡检报告失败' })) as { detail?: string }
    throw new Error(error.detail || '保存巡检报告失败')
  }
  return res.json() as Promise<InspectionReport>
}

/**
 * Submit inspection report for a specific period and project
 */
export async function submitReport(periodId: number, projectId: number): Promise<InspectionReport> {
  const res = await fetch(resolveApiUrl(`/api/v1/inspections/periods/${periodId}/projects/${projectId}/submit`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })
  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: '提交巡检报告失败' })) as { detail?: string }
    throw new Error(error.detail || '提交巡检报告失败')
  }
  return res.json() as Promise<InspectionReport>
}

/**
 * Upload inspection screenshot — via /api/inspections/screenshot-upload proxy route
 * which forwards FormData as ArrayBuffer (preserving multipart boundary).
 */
export async function uploadScreenshot(file: File, reportId: number): Promise<InspectionScreenshot> {
  const formData = new FormData()
  formData.append('file', file)
  formData.append('report_id', String(reportId))

  const res = await fetch('/api/inspections/screenshot-upload', {
    method: 'POST',
    body: formData,
  })
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: '上传截图失败' })) as { error?: string }
    throw new Error(error?.error || '上传截图失败')
  }
  return res.json() as Promise<InspectionScreenshot>
}

/**
 * Delete inspection screenshot
 */
export async function deleteScreenshot(screenshotId: number): Promise<void> {
  const res = await fetch(resolveApiUrl(`/api/v1/inspections/screenshots/${screenshotId}`), {
    method: 'DELETE',
  })
  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: '删除截图失败' })) as { detail?: string }
    throw new Error(error.detail || '删除截图失败')
  }
}

/**
 * Fetch inspection history with optional filters
 */
export async function fetchInspectionHistory(
  params?: {
    periodId?: number
    projectId?: number
    limit?: number
    offset?: number
  }
): Promise<InspectionHistoryResponse> {
  const searchParams = new URLSearchParams()
  if (params?.periodId !== undefined) searchParams.set('period_id', String(params.periodId))
  if (params?.projectId !== undefined) searchParams.set('project_id', String(params.projectId))
  if (params?.limit !== undefined) searchParams.set('limit', String(params.limit))
  if (params?.offset !== undefined) searchParams.set('offset', String(params.offset))

  const query = searchParams.toString()
  const url = resolveApiUrl('/api/v1/inspections/history') + (query ? `?${query}` : '')

  const res = await fetch(url)
  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: '获取巡检历史失败' })) as { detail?: string }
    throw new Error(error.detail || '获取巡检历史失败')
  }
  return res.json() as Promise<InspectionHistoryResponse>
}