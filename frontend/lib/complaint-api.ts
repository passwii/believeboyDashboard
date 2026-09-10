/**
 * 客诉中心（Complaint Center）前端 API 层。
 * 调用走 /api/backend 代理，session 鉴权，与 inspection-api 同模式。
 *
 * 后端契约：BLF-981 / BLF-1000，对齐 inventory/shipments project_id + country 模式。
 * 后端响应 DTO（backend/app/schemas/complaint_center.py ComplaintListItem / ComplaintDetail）
 * 与页面模型有字段差异（order_info vs order、无 project_name / SLA 派生列），
 * 统一在本文件的映射层消化，页面只消费映射后的模型。
 */

// ======================== 类型导出 ========================

export type ComplaintStatus = 'pending' | 'drafted' | 'replied' | 'resolved' | 'closed_no_response'
export type ComplaintCategory = 'with_order' | 'no_order_info' | 'spam'
export type CheckStatus = 'ok' | 'login_page' | 'launch_fail' | 'identity_mismatch'
export type ComplaintSlaLevel = 'ok' | 'soon' | 'overdue' | 'closed'

export interface ComplaintOrderInfo {
  order_id: string
  asin: string
  product_title: string
  qty: number
  purchased_at: string | null
  shipped_at: string | null
  delivered_at: string | null
}

export interface ComplaintTriage {
  category: ComplaintCategory
  has_order: boolean
  summary_zh: string
}

export interface ComplaintSLA {
  reply_deadline: string | null
  expires_soon: boolean
}

export interface ComplaintSummaryItem {
  id: number
  project_id: number
  project_name: string
  country: string
  buyer_name: string
  message_date: string
  subject: string
  category: ComplaintCategory
  category_badge: string
  has_order: boolean
  order_id: string | null
  asin: string | null
  product_title: string | null
  status: ComplaintStatus
  sla_remaining: string
  sla_level: ComplaintSlaLevel
}

export interface ComplaintOverview {
  date: string
  metrics: {
    total_needs_reply: number
    total_reported_unresolved: number
    total_resolved: number
    sla_due_soon: number
    sla_overdue: number
  }
  trend: Array<{ date: string; needs_reply: number }>
  projects: Array<{
    project_id: number
    project_name: string
    country: string
    check_status: CheckStatus
    needs_reply: number
    resolved: number
    sla_due_soon: number
  }>
}

export interface ComplaintDetail {
  id: number
  project_id: number
  project_name: string
  country: string
  buyer_name: string
  message_date: string
  subject: string
  message_body: string
  triage: ComplaintTriage
  category: ComplaintCategory
  has_order: boolean
  order: ComplaintOrderInfo | null
  sla: ComplaintSLA
  status: ComplaintStatus
  draft_path: string | null
  reply_sent_at: string | null
  handler_note: string | null
  status_history: Array<{
    from: ComplaintStatus | null
    to: ComplaintStatus
    at: string
    by: string
  }>
}

export interface ComplaintListParams {
  date?: string
  first_message_date?: string
  project_id?: number
  category?: ComplaintCategory | ''
  status?: ComplaintStatus | ''
  country?: string
  keyword?: string
  sort?: 'sla_asc' | 'sla_desc' | 'date_asc' | 'date_desc'
  page?: number
  page_size?: number
}

export interface ComplaintListResponse {
  items: ComplaintSummaryItem[]
  total: number
  page: number
  page_size: number
  spam_count: number
}

export interface ComplaintStatusChangePayload {
  status: ComplaintStatus
  draft_path?: string
  reply_sent_at?: string
  handler_note?: string
}

// ======================== 后端 DTO（映射层输入）========================

/**
 * 后端 ComplaintListItem / ComplaintDetail 的原始响应（BLF-1000 修复后契约）。
 * 前端不直接消费，统一经 mapComplaint* 转为页面模型。
 */
export interface ComplaintBackendItem {
  id: number
  run_id: number
  project_id: number
  country: string
  buyer_name: string
  message_date: string
  subject: string
  category: ComplaintCategory
  has_order: boolean
  status: ComplaintStatus
  draft_path?: string | null
  reply_sent_at?: string | null
  handler_note?: string | null
  created_at: string
  updated_at: string
  /** 后端未 join 时缺失，映射层用 projectNameById 兜底 */
  project_name?: string
  /** 后端详情键名 order_info；列表项经映射层取 order 快照 */
  order_info?: ComplaintOrderInfo | null
  /** 详情字段 */
  message_body?: string
  triage?: ComplaintTriage | null
  sla?: ComplaintSLA | null
  status_history?: Array<{
    from: ComplaintStatus | null
    to: ComplaintStatus
    at: string
    by: string
  }>
}

export interface ComplaintBackendListResponse {
  items: ComplaintBackendItem[]
  total: number
  page: number
  page_size: number
  spam_count?: number
}

// ======================== 派生展示层（映射层）========================

const CATEGORY_BADGE: Record<ComplaintCategory, string> = {
  with_order: '有订单',
  no_order_info: '无订单',
  spam: '垃圾',
}

/** 已回复及之后的状态：SLA 不再倒计时。 */
const CLOSED_STATUSES: Record<ComplaintStatus, boolean> = {
  pending: false,
  drafted: false,
  replied: true,
  resolved: true,
  closed_no_response: true,
}

function isFiniteDate(iso: string | null | undefined): iso is string {
  if (!iso) return false
  return !Number.isNaN(new Date(iso).getTime())
}

/**
 * SLA 展示值与等级（列表 SLA 列 + 详情 SLA 行共用）。
 * - 已回复/已解决/关闭 → 已关闭 / closed
 * - 无截止时间 → 无 SLA / closed（不参与倒计时）
 * - 过期 → 过期 N 天 / overdue；24h 内 → 剩 Nh / soon；否则 → 剩 Nd / ok
 */
export function deriveSla(
  status: ComplaintStatus,
  sla: ComplaintSLA | null | undefined
): { sla_remaining: string; sla_level: ComplaintSlaLevel } {
  if (CLOSED_STATUSES[status]) return { sla_remaining: '已关闭', sla_level: 'closed' }
  const deadline = sla?.reply_deadline
  if (!isFiniteDate(deadline)) return { sla_remaining: '无 SLA', sla_level: 'closed' }
  const diffMs = new Date(deadline).getTime() - Date.now()
  if (diffMs < 0) {
    const days = Math.max(1, Math.ceil(-diffMs / 86_400_000))
    return { sla_remaining: `过期 ${days}d`, sla_level: 'overdue' }
  }
  if (diffMs < 86_400_000) return { sla_remaining: `剩 ${Math.floor(diffMs / 3_600_000)}h`, sla_level: 'soon' }
  return { sla_remaining: `剩 ${Math.ceil(diffMs / 86_400_000)}d`, sla_level: 'ok' }
}

/** 详情/列表通用：后端 DTO → 页面 ComplaintSummaryItem。 */
export function mapComplaintItem(
  dto: ComplaintBackendItem,
  projectNameById?: ReadonlyMap<number, string>
): ComplaintSummaryItem {
  const { sla_remaining, sla_level } = deriveSla(dto.status, dto.sla)
  return {
    id: dto.id,
    project_id: dto.project_id,
    project_name: dto.project_name ?? projectNameById?.get(dto.project_id) ?? `#${dto.project_id}`,
    country: dto.country,
    buyer_name: dto.buyer_name,
    message_date: String(dto.message_date).slice(0, 10),
    subject: dto.subject,
    category: dto.category,
    category_badge: CATEGORY_BADGE[dto.category] ?? dto.category,
    has_order: dto.has_order,
    order_id: dto.order_info?.order_id ?? null,
    asin: dto.order_info?.asin ?? null,
    product_title: dto.order_info?.product_title ?? null,
    status: dto.status,
    sla_remaining,
    sla_level,
  }
}

/** 详情专用：后端 DTO → 页面 ComplaintDetail（含原文/摘要/状态历史）。 */
export function mapComplaintDetail(
  dto: ComplaintBackendItem,
  projectNameById?: ReadonlyMap<number, string>
): ComplaintDetail {
  const summary = mapComplaintItem(dto, projectNameById)
  return {
    ...summary,
    message_body: dto.message_body ?? '',
    triage: dto.triage ?? { category: dto.category, has_order: dto.has_order, summary_zh: '' },
    order: dto.order_info ?? null,
    sla: dto.sla ?? { reply_deadline: null, expires_soon: false },
    draft_path: dto.draft_path ?? null,
    reply_sent_at: dto.reply_sent_at ?? null,
    handler_note: dto.handler_note ?? null,
    status_history: (dto.status_history ?? []).map((h) => ({
      from: h.from ?? null,
      to: h.to,
      at: h.at,
      by: h.by,
    })),
  }
}

// ======================== API 调用 ========================

const API_BASE = '/api/backend'

function resolveApiUrl(path: string) {
  return `${API_BASE}/${path.replace(/^\/+/, '')}`
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(resolveApiUrl(path), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`API ${res.status}: ${body.slice(0, 200)}`)
  }
  return (await res.json()) as T
}

export async function fetchComplaintOverview(params?: {
  date?: string
  country?: string
}): Promise<ComplaintOverview> {
  const qs = new URLSearchParams()
  if (params?.date) qs.set('date', params.date)
  if (params?.country) qs.set('country', params.country)
  return request<ComplaintOverview>(`v1/complaints/overview?${qs}`)
}

/**
 * 客诉列表。
 * 项目名兜底：后端列表项不含 project_name（列表接口不做 join），
 * 前端用 /projects/manage 的缓存兜底映射，避免列表出现 #18 这类裸 ID。
 */
export async function fetchComplaintList(
  params?: ComplaintListParams,
  projectNameById?: ReadonlyMap<number, string>
): Promise<ComplaintListResponse> {
  const qs = new URLSearchParams()
  if (params?.date) qs.set('date', params.date)
  if (params?.first_message_date) qs.set('first_message_date', params.first_message_date)
  if (params?.project_id) qs.set('project_id', String(params.project_id))
  if (params?.category) qs.set('category', params.category)
  if (params?.status) qs.set('status', params.status)
  if (params?.country) qs.set('country', params.country)
  if (params?.keyword) qs.set('keyword', params.keyword)
  if (params?.sort) qs.set('sort', params.sort)
  if (params?.page) qs.set('page', String(params.page))
  if (params?.page_size) qs.set('page_size', String(params.page_size))
  const raw = await request<ComplaintBackendListResponse>(`v1/complaints?${qs}`)
  const items = raw.items.map((dto) => mapComplaintItem(dto, projectNameById))
  return { items, total: raw.total, page: raw.page, page_size: raw.page_size, spam_count: raw.spam_count ?? 0 }
}

export async function fetchComplaintDetail(
  id: number,
  projectNameById?: ReadonlyMap<number, string>
): Promise<ComplaintDetail | null> {
  const raw = await request<ComplaintBackendItem>(`v1/complaints/${id}`)
  return mapComplaintDetail(raw, projectNameById)
}

export async function changeComplaintStatus(
  id: number,
  payload: ComplaintStatusChangePayload,
  projectNameById?: ReadonlyMap<number, string>
): Promise<ComplaintDetail> {
  const raw = await request<ComplaintBackendItem>(`v1/complaints/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
  return mapComplaintDetail(raw, projectNameById)
}
