/**
 * CRM 后端 DTO ↔ 前端类型 映射器。
 *
 * 后端：snake_case + int 主键（owner_id/created_by 为 UUID 字符串）。
 * 前端：camelCase + string 主键。
 * 逐字段映射（不整体转换，避免漏字段）；null → undefined（前端可选字段缺省）。
 */
import type {
  Customer,
  CustomerInput,
  Follow,
  FollowInput,
  Lead,
  LeadInput,
  User,
} from '@/lib/crm/types'

// ---------- 后端 DTO 形状（snake_case） ----------
export interface CustomerDto {
  id: number
  name: string
  short_name?: string | null
  industry?: string | null
  customer_type?: string | null
  interested_service?: string | null
  rating: string
  status: string
  source?: string | null
  owner_id?: string | null
  owner_name?: string | null
  contact_name?: string | null
  contact_phone?: string | null
  contact_email?: string | null
  address?: string | null
  website?: string | null
  annual_revenue?: number | null
  employee_count?: number | null
  remark?: string | null
  last_follow_at?: string | null
  created_by?: string | null
  created_at: string
  updated_at: string
}

export interface LeadDto {
  id: number
  name: string
  company?: string | null
  phone?: string | null
  email?: string | null
  wechat?: string | null
  source?: string | null
  status: string
  intent: string
  customer_type?: string | null
  interested_service?: string | null
  owner_id?: string | null
  owner_name?: string | null
  expected_amount?: number | null
  expected_close_date?: string | null
  remark?: string | null
  converted_to_customer_id?: number | null
  converted_at?: string | null
  created_by?: string | null
  created_at: string
  updated_at: string
}

export interface FollowDto {
  id: number
  entity_type: string
  entity_id: number
  type: string
  content: string
  next_follow_at?: string | null
  created_by?: string | null
  created_by_name?: string | null
  created_at: string
}

export interface UserDto {
  id: string
  name: string
  email: string
  role_type?: string | null
  is_active: boolean
}

// ---------- 出站映射（snake → camel，int → string） ----------
export function mapCustomer(dto: CustomerDto): Customer {
  return {
    id: String(dto.id),
    name: dto.name,
    shortName: dto.short_name ?? undefined,
    industry: dto.industry ?? undefined,
    customerType: dto.customer_type ?? undefined,
    interestedService: dto.interested_service ?? undefined,
    rating: dto.rating as Customer['rating'],
    status: dto.status as Customer['status'],
    source: (dto.source ?? 'other') as Customer['source'],
    ownerId: dto.owner_id ?? null,
    ownerName: dto.owner_name ?? undefined,
    contactName: dto.contact_name ?? undefined,
    contactPhone: dto.contact_phone ?? undefined,
    contactEmail: dto.contact_email ?? undefined,
    address: dto.address ?? undefined,
    website: dto.website ?? undefined,
    annualRevenue: dto.annual_revenue ?? undefined,
    employeeCount: dto.employee_count ?? undefined,
    remark: dto.remark ?? undefined,
    createdAt: dto.created_at,
    updatedAt: dto.updated_at,
    createdBy: dto.created_by ?? '',
    lastFollowAt: dto.last_follow_at ?? undefined,
  }
}

export function mapLead(dto: LeadDto): Lead {
  return {
    id: String(dto.id),
    name: dto.name,
    company: dto.company ?? undefined,
    phone: dto.phone ?? undefined,
    email: dto.email ?? undefined,
    wechat: dto.wechat ?? undefined,
    source: (dto.source ?? 'other') as Lead['source'],
    status: dto.status as Lead['status'],
    intent: dto.intent as Lead['intent'],
    customerType: dto.customer_type ?? undefined,
    interestedService: dto.interested_service ?? undefined,
    ownerId: dto.owner_id ?? null,
    ownerName: dto.owner_name ?? undefined,
    expectedAmount: dto.expected_amount ?? undefined,
    expectedCloseDate: dto.expected_close_date ?? undefined,
    remark: dto.remark ?? undefined,
    createdAt: dto.created_at,
    updatedAt: dto.updated_at,
    convertedToCustomerId:
      dto.converted_to_customer_id != null ? String(dto.converted_to_customer_id) : undefined,
    convertedAt: dto.converted_at ?? undefined,
  }
}

export function mapFollow(dto: FollowDto): Follow {
  return {
    id: String(dto.id),
    entityType: dto.entity_type as Follow['entityType'],
    entityId: String(dto.entity_id),
    type: dto.type as Follow['type'],
    content: dto.content,
    nextFollowAt: dto.next_follow_at ?? undefined,
    createdBy: dto.created_by ?? '',
    createdByName: dto.created_by_name ?? undefined,
    createdAt: dto.created_at,
  }
}

export function mapUser(dto: UserDto): User {
  return {
    id: String(dto.id),
    name: dto.name,
    email: dto.email,
    roleType: (dto.role_type ?? 'operator') as User['roleType'],
    isActive: dto.is_active,
  }
}

// ---------- 入站映射（camel → snake；undefined 剔除，配合后端 exclude_unset） ----------
function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v
  }
  return out
}

/** 客户创建/更新入参。contact* 为展示字段（来自后端 join），不入站。 */
export function toCustomerPayload(input: Partial<CustomerInput>): Record<string, unknown> {
  return stripUndefined({
    name: input.name,
    short_name: input.shortName,
    industry: input.industry,
    customer_type: input.customerType,
    interested_service: input.interestedService,
    rating: input.rating,
    status: input.status,
    source: input.source,
    owner_id: input.ownerId,
    address: input.address,
    website: input.website,
    annual_revenue: input.annualRevenue,
    employee_count: input.employeeCount,
    remark: input.remark,
  })
}

/** 线索创建/更新入参。 */
export function toLeadPayload(input: Partial<LeadInput>): Record<string, unknown> {
  return stripUndefined({
    name: input.name,
    company: input.company,
    phone: input.phone,
    email: input.email,
    wechat: input.wechat,
    source: input.source,
    status: input.status,
    intent: input.intent,
    customer_type: input.customerType,
    interested_service: input.interestedService,
    owner_id: input.ownerId,
    expected_amount: input.expectedAmount,
    expected_close_date: input.expectedCloseDate,
    remark: input.remark,
  })
}

/** 跟进入参。created_by 由后端按鉴权头填，不入站；entity_id 转 int。 */
export function toFollowPayload(input: FollowInput): Record<string, unknown> {
  return stripUndefined({
    entity_type: input.entityType,
    entity_id: Number(input.entityId),
    type: input.type,
    content: input.content,
    next_follow_at: input.nextFollowAt,
  })
}

/** 转化线索入参（ConvertLeadRequest：仅 name/rating/source/remark 可覆盖）。 */
export function toConvertPayload(
  input?: Partial<CustomerInput>
): Record<string, unknown> | undefined {
  if (!input) return undefined
  const payload = stripUndefined({
    name: input.name,
    rating: input.rating,
    source: input.source,
    remark: input.remark,
  })
  return Object.keys(payload).length > 0 ? payload : undefined
}
