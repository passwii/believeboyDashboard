/**
 * Type re-exports for the inspection API.
 *
 * Per BEL-22-3 / BEL-29, the **single source of truth** for these DTOs lives in
 * `backend/app/schemas/inspection.py`. We re-export the auto-generated
 * `components["schemas"][...]` aliases here so the rest of the frontend can
 * keep importing from `@/lib/inspection-api` without churn.
 *
 * The shapes are compatible with the previous hand-written interfaces — the
 * only differences:
 *   - `null` is now explicit on optional fields (the generated types use
 *     `T | null` for fields Pydantic declares as `Optional[...] = None`).
 *   - `InspectionReport.status` is `string` instead of a literal union; the
 *     backend controls the canonical list of statuses and we'd rather fail
 *     open than block valid responses.
 *
 * If you find yourself needing a shape that is *not* a re-export, you are
 * adding a new schema — update `backend/app/schemas/inspection.py` and run
 * `make openapi-export && pnpm gen:api-types`. Do not hand-mirror here.
 */
import type { components } from '@/types/api-generated/api'

export type HealthData = components['schemas']['HealthData']
export type ComplianceData = components['schemas']['ComplianceData']
export type InspectionTemplateField = components['schemas']['InspectionTemplateField']
export type InspectionTemplate = components['schemas']['InspectionTemplateResponse']
export type InspectionPeriod = components['schemas']['InspectionPeriodItem']
export type InspectionScreenshot = components['schemas']['InspectionScreenshotItem']
export type InspectionReport = components['schemas']['InspectionReportItem']
export type InspectionOverviewItem = components['schemas']['InspectionOverviewItem']
export type InspectionOverview = components['schemas']['InspectionOverviewResponse']
export type InspectionHistoryScreenshot = components['schemas']['InspectionHistoryScreenshot']
export type InspectionHistoryItem = components['schemas']['InspectionHistoryItem']
export type InspectionHistoryResponse = components['schemas']['InspectionHistoryResponse']

const API_BASE = '/api/backend'

function resolveApiUrl(path: string) {
  const base = API_BASE.endsWith('/') ? API_BASE.slice(0, -1) : API_BASE
  return `${base}${path}`
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
