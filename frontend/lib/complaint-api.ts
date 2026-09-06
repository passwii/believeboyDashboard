/**
 * 客诉中心（Complaint Center）前端 API 层。
 * 调用走 /api/backend 代理，session 鉴权，与 inspection-api 同模式。
 *
 * 后端契约：BLF-981，对齐 inventory/shipments project_id + country 模式。
 * 联调前用 MOCK_DATA 兜底，端点就绪后切换 useMock=false 即可。
 */
import type { components } from '@/types/api-generated/api'

// ======================== 类型导出 ========================

export type ComplaintStatus = 'pending' | 'drafted' | 'replied' | 'resolved' | 'closed_no_response'
export type ComplaintCategory = 'with_order' | 'no_order_info' | 'spam'
export type CheckStatus = 'ok' | 'login_page' | 'launch_fail' | 'identity_mismatch'

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
  reply_deadline: string
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
  sla_level: 'ok' | 'soon' | 'overdue' | 'closed'
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

// ======================== Mock 数据集 ========================

/**
 * 2026-09-04 真实数据集（BLF-981 联调用）。
 * 15 店铺，3 客诉 — 犀牛 1 条有订单，吕沃 2 条无订单信息（含 1 垃圾）。
 */
export const MOCK_OVERVIEW: ComplaintOverview = {
  date: '2026-09-04',
  metrics: {
    total_needs_reply: 3,
    total_reported_unresolved: 0,
    total_resolved: 0,
    sla_due_soon: 1,
    sla_overdue: 0,
  },
  trend: [
    { date: '2026-08-15', needs_reply: 1 },
    { date: '2026-08-20', needs_reply: 2 },
    { date: '2026-08-25', needs_reply: 1 },
    { date: '2026-08-30', needs_reply: 2 },
    { date: '2026-09-04', needs_reply: 3 },
  ],
  projects: [
    { project_id: 1, project_name: '犀牛', country: 'US', check_status: 'ok', needs_reply: 1, resolved: 0, sla_due_soon: 1 },
    { project_id: 2, project_name: '吕沃', country: 'US', check_status: 'ok', needs_reply: 2, resolved: 0, sla_due_soon: 0 },
    ...Array.from({ length: 13 }, (_, i) => ({
      project_id: i + 3,
      project_name: `Project${i + 3}`,
      country: 'US' as const,
      check_status: 'ok' as const,
      needs_reply: 0,
      resolved: 0,
      sla_due_soon: 0,
    })),
  ],
}

const MOCK_COMPLAINTS: ComplaintDetail[] = [
  {
    id: 789,
    project_id: 1,
    project_name: '犀牛',
    country: 'US',
    buyer_name: 'Crystal',
    message_date: '2026-09-02',
    subject: 'Product details inquiry — Electric Blanket',
    message_body:
      'Need another blanket. I bought one about a year ago and now it stopped working. Can you help?',
    triage: {
      category: 'with_order',
      has_order: true,
      summary_zh: '买家称去年买的电热毯坏了，想再买一条',
    },
    category: 'with_order',
    has_order: true,
    order: {
      order_id: '112-8707798-7079456',
      asin: 'B0CR19VKBX',
      product_title: 'XINIUSLEEP Electric Blanket Twin...',
      qty: 1,
      purchased_at: '2025-01-04T23:58:00+08:00',
      shipped_at: '2025-01-05T15:59:00+08:00',
      delivered_at: '2025-01-08T15:59:00+08:00',
    },
    sla: { reply_deadline: '2026-09-05T01:08:00+08:00', expires_soon: true },
    status: 'pending',
    draft_path: null,
    reply_sent_at: null,
    handler_note: null,
    status_history: [
      { from: null, to: 'pending', at: '2026-09-04T10:00:00+08:00', by: 'agent:complaint_bot' },
    ],
  },
  {
    id: 790,
    project_id: 2,
    project_name: '吕沃',
    country: 'US',
    buyer_name: 'JohnDoe42',
    message_date: '2026-09-03',
    subject: 'Do you have discounts?',
    message_body: 'Is there any coupon code? Just wondering if I can get a discount.',
    triage: {
      category: 'no_order_info',
      has_order: false,
      summary_zh: '买家询问折扣，无订单信息',
    },
    category: 'no_order_info',
    has_order: false,
    order: null,
    sla: { reply_deadline: '2026-09-06T09:00:00+08:00', expires_soon: false },
    status: 'pending',
    draft_path: null,
    reply_sent_at: null,
    handler_note: null,
    status_history: [
      { from: null, to: 'pending', at: '2026-09-04T10:00:00+08:00', by: 'agent:complaint_bot' },
    ],
  },
  {
    id: 791,
    project_id: 2,
    project_name: '吕沃',
    country: 'US',
    buyer_name: 'SpamBot',
    message_date: '2026-09-03',
    subject: 'Buy cheap shoes now!!!',
    message_body: 'A completely unrelated spam message about shoes.',
    triage: {
      category: 'spam',
      has_order: false,
      summary_zh: '无关推广信息，已标记垃圾',
    },
    category: 'spam',
    has_order: false,
    order: null,
    sla: { reply_deadline: '2026-09-06T09:00:00+08:00', expires_soon: false },
    status: 'pending',
    draft_path: null,
    reply_sent_at: null,
    handler_note: null,
    status_history: [
      { from: null, to: 'pending', at: '2026-09-04T10:00:00+08:00', by: 'agent:complaint_bot' },
    ],
  },
]

function mockList(params?: ComplaintListParams): ComplaintListResponse {
  let items = MOCK_COMPLAINTS.map(mockToSummary)
  if (params?.category) items = items.filter((i) => i.category === params.category)
  if (params?.status) items = items.filter((i) => i.status === params.status)
  if (params?.project_id) items = items.filter((i) => i.project_id === params.project_id)
  if (params?.country) items = items.filter((i) => i.country === params.country)
  if (params?.keyword) {
    const kw = params.keyword.toLowerCase()
    items = items.filter((i) => i.buyer_name.toLowerCase().includes(kw) || i.subject.toLowerCase().includes(kw))
  }
  const spam_count = items.filter((i) => i.category === 'spam').length
  const filtered = items.filter((i) => i.category !== 'spam')
  const total = filtered.length
  const page = params?.page ?? 1
  const page_size = params?.page_size ?? 20
  return { items: filtered, total, page, page_size, spam_count }
}

function mockToSummary(d: ComplaintDetail): ComplaintSummaryItem {
  const badgeMap: Record<ComplaintCategory, string> = { with_order: '有订单', no_order_info: '无订单', spam: '垃圾' }
  const deadline = new Date(d.sla.reply_deadline).getTime()
  const now = Date.now()
  const diff = deadline - now
  const hours = Math.max(0, Math.floor(diff / 3.6e6))
  let sla_remaining: string
  let sla_level: ComplaintSummaryItem['sla_level']
  if (d.status === 'resolved' || d.status === 'closed_no_response') {
    sla_remaining = '已关闭'
    sla_level = 'closed'
  } else if (diff < 0) {
    sla_remaining = '过期'
    sla_level = 'overdue'
  } else if (diff < 86400000) {
    sla_remaining = `剩 ${hours}h`
    sla_level = 'soon'
  } else {
    sla_remaining = `剩 ${Math.ceil(diff / 86400000)}d`
    sla_level = 'ok'
  }
  return {
    id: d.id,
    project_id: d.project_id,
    project_name: d.project_name,
    country: d.country,
    buyer_name: d.buyer_name,
    message_date: d.message_date,
    subject: d.subject,
    category: d.category,
    category_badge: badgeMap[d.category],
    has_order: d.has_order,
    order_id: d.order?.order_id ?? null,
    asin: d.order?.asin ?? null,
    product_title: d.order?.product_title ?? null,
    status: d.status,
    sla_remaining,
    sla_level,
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

/**
 * 是否使用 mock 数据。后端端点就绪后改 false 即可切换真实端点。
 */
let useMock = false

export function setUseComplaintMock(value: boolean) {
  useMock = value
}

export async function fetchComplaintOverview(params?: {
  date?: string
  country?: string
}): Promise<ComplaintOverview> {
  if (useMock) return MOCK_OVERVIEW
  const qs = new URLSearchParams()
  if (params?.date) qs.set('date', params.date)
  if (params?.country) qs.set('country', params.country)
  return request<ComplaintOverview>(`v1/complaints/overview?${qs}`)
}

export async function fetchComplaintList(params?: ComplaintListParams): Promise<ComplaintListResponse> {
  if (useMock) return mockList(params)
  const qs = new URLSearchParams()
  if (params?.date) qs.set('date', params.date)
  if (params?.project_id) qs.set('project_id', String(params.project_id))
  if (params?.category) qs.set('category', params.category)
  if (params?.status) qs.set('status', params.status)
  if (params?.country) qs.set('country', params.country)
  if (params?.keyword) qs.set('keyword', params.keyword)
  if (params?.sort) qs.set('sort', params.sort)
  if (params?.page) qs.set('page', String(params.page))
  if (params?.page_size) qs.set('page_size', String(params.page_size))
  return request<ComplaintListResponse>(`v1/complaints?${qs}`)
}

export async function fetchComplaintDetail(id: number): Promise<ComplaintDetail | null> {
  if (useMock) return MOCK_COMPLAINTS.find((c) => c.id === id) ?? null
  return request<ComplaintDetail>(`v1/complaints/${id}`)
}

export async function changeComplaintStatus(
  id: number,
  payload: ComplaintStatusChangePayload
): Promise<ComplaintDetail> {
  if (useMock) {
    const c = MOCK_COMPLAINTS.find((x) => x.id === id)
    if (!c) throw new Error(`Complaint ${id} not found`)
    c.status = payload.status
    c.draft_path = payload.draft_path ?? c.draft_path
    c.reply_sent_at = payload.reply_sent_at ?? c.reply_sent_at
    c.handler_note = payload.handler_note ?? c.handler_note
    c.status_history.push({
      from: c.status,
      to: payload.status,
      at: new Date().toISOString(),
      by: 'operator:dashboard',
    })
    return c
  }
  return request<ComplaintDetail>(`v1/complaints/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
}
