/**
 * CRM 后端 DTO ↔ 前端类型 映射器。
 *
 * 后端：snake_case + int 主键（owner_id/created_by 为 UUID 字符串）。
 * 前端：camelCase + string 主键。
 * 逐字段映射（不整体转换，避免漏字段）；null → undefined（前端可选字段缺省）。
 */
import type {
  AuditLog,
  Category,
  CategoryInput,
  Contact,
  ContactInput,
  Customer,
  CustomerInput,
  CustomerSeaImportRow,
  CustomerSeaImportResult,
  DashboardStats,
  Follow,
  FollowInput,
  FollowUpGroups,
  FollowUpItem,
  FunnelStageDetail,
  Lead,
  LeadInput,
  LifecycleBoard,
  LifecycleDistribution,
  Proposal,
  ProposalContent,
  ProposalCreateInput,
  ProposalDetail,
  ProposalUpdateInput,
  ProposalUploadResult,
  ProposalVersion,
  ProposalVersionInput,
  Task,
  TaskInput,
  Rule,
  RuleInput,
  RuleCondition,
  RuleAction,
  User,
  WorkflowSettings,
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
  score_scale?: string | null
  score_pay?: string | null
  score_fit?: string | null
  score_coop?: string | null
  categories?: Array<{ id: number; name: string }>
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
  next_follow_at?: string | null
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
  next_follow_at?: string | null
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

export interface CategoryDto {
  id: number
  name: string
  sort_order: number
  created_at: string
}

export interface FollowUpItemDto {
  entity_type: string
  entity_id: number
  name: string
  subtitle?: string | null
  owner_id?: string | null
  owner_name?: string | null
  next_follow_at: string
  last_follow_content?: string | null
  last_follow_at?: string | null
  rating?: string | null
  status?: string | null
  intent?: string | null
}

export interface FollowUpGroupsDto {
  overdue: FollowUpItemDto[]
  today: FollowUpItemDto[]
  this_week: FollowUpItemDto[]
  overdue_count: number
  total_count: number
}

export interface ContactDto {
  id: number
  customer_id: number
  name: string
  phone?: string | null
  email?: string | null
  wechat?: string | null
  title?: string | null
  is_primary: boolean
  remark?: string | null
  created_at: string
  updated_at: string
}

export interface DashboardStatsDto {
  lead_funnel: Record<string, number>
  new_this_month: {
    new_customers: number
    new_leads: number
    converted_count: number
  }
  follow_activity: {
    follow_count_7d: number
  }
  per_owner: {
    owner_id: string
    owner_name?: string | null
    customer_count: number
    converted_this_month: number
  }[]
}

/** 漏斗二层面板：阶段明细 DTO（BLF-517 后端 StageDetail）。 */
export interface StageLeadItemDto {
  id: number
  name: string
  company?: string | null
  owner_id?: string | null
  owner_name?: string | null
  source?: string | null
  intent?: string | null
  entered_stage_at?: string | null
  last_action_at?: string | null
  last_action_content?: string | null
  next_follow_at?: string | null
  dwell_days?: number | null
  is_stuck: boolean
}

export interface StageDetailDto {
  stage: string
  count: number
  avg_dwell_days?: number | null
  stuck_count: number
  inflow: number
  outflow?: number | null
  stuck_days: number
  leads: StageLeadItemDto[]
  page: number
  page_size: number
  total: number
}

/** 生命周期看板 DTO（BLF-520 后端 LifecycleBoard）。 */
export interface LifecycleBucketDto {
  label: string
  min_days: number
  max_days?: number | null
  count: number
  pct: number
  cumulative_pct: number
}

export interface LifecycleSummaryDto {
  sample_count: number
  total_count: number
  avg_days?: number | null
  median_days?: number | null
  p90_days?: number | null
  max_days?: number | null
}

export interface LifecycleDistributionDto {
  metric: string
  label: string
  description: string
  buckets: LifecycleBucketDto[]
  summary: LifecycleSummaryDto
}

export interface LifecycleBoardDto {
  first_follow: LifecycleDistributionDto
  conversion: LifecycleDistributionDto
  churn: LifecycleDistributionDto
  now_in_sea: number
}

export interface AuditLogDto {
  id: number
  entity_type: string
  entity_id: number
  action: string
  actor_id?: string | null
  actor_name?: string | null
  summary?: string | null
  created_at: string
}

// ---------- 规则引擎（P9，BLF-543/545）：后端 DTO（snake_case） ----------
export interface RuleConditionDto {
  id?: number
  field: string
  operator: string
  value?: string | null
  sort_order: number
}

export interface RuleActionDto {
  id?: number
  action_type: string
  params?: Record<string, unknown> | null
  sort_order: number
}

export interface RuleDto {
  id: number
  name: string
  description?: string | null
  entity_type: string
  event_type: string
  enabled: boolean
  priority: number
  conditions: RuleConditionDto[]
  actions: RuleActionDto[]
  created_by?: string | null
  created_at: string
  updated_at: string
}

export interface TaskDto {
  id: number
  title: string
  description?: string | null
  due_date?: string | null
  priority: string
  status: string
  type: string
  owner_id?: string | null
  owner_name?: string | null
  customer_id?: number | null
  customer_name?: string | null
  lead_id?: number | null
  lead_name?: string | null
  reminded_at?: string | null
  created_by?: string | null
  completed_at?: string | null
  created_at: string
  updated_at: string
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
    scoreScale: (dto.score_scale as Customer['scoreScale']) ?? null,
    scorePay: (dto.score_pay as Customer['scorePay']) ?? null,
    scoreFit: (dto.score_fit as Customer['scoreFit']) ?? null,
    scoreCoop: (dto.score_coop as Customer['scoreCoop']) ?? null,
    categories: (dto.categories ?? []).map((c) => ({
      id: String(c.id),
      name: c.name,
    })),
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
    nextFollowAt: dto.next_follow_at ?? undefined,
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
    nextFollowAt: dto.next_follow_at ?? undefined,
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

export function mapCategory(dto: CategoryDto): Category {
  return {
    id: String(dto.id),
    name: dto.name,
    sortOrder: dto.sort_order,
    createdAt: dto.created_at,
  }
}

export function toCategoryPayload(
  input: Partial<CategoryInput>
): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  if (input.name !== undefined) payload.name = input.name
  if (input.sortOrder !== undefined) payload.sort_order = input.sortOrder
  return payload
}

export function mapFollowUp(dto: FollowUpItemDto): FollowUpItem {
  return {
    entityType: dto.entity_type as FollowUpItem['entityType'],
    entityId: String(dto.entity_id),
    name: dto.name,
    subtitle: dto.subtitle ?? undefined,
    ownerId: dto.owner_id ?? null,
    ownerName: dto.owner_name ?? undefined,
    nextFollowAt: dto.next_follow_at,
    lastFollowContent: dto.last_follow_content ?? undefined,
    lastFollowAt: dto.last_follow_at ?? undefined,
    rating: dto.rating ?? undefined,
    status: dto.status ?? undefined,
    intent: dto.intent ?? undefined,
  }
}

export function mapFollowUpGroups(dto: FollowUpGroupsDto): FollowUpGroups {
  return {
    overdue: dto.overdue.map(mapFollowUp),
    today: dto.today.map(mapFollowUp),
    thisWeek: dto.this_week.map(mapFollowUp),
    overdueCount: dto.overdue_count,
    totalCount: dto.total_count,
  }
}

export function mapContact(dto: ContactDto): Contact {
  return {
    id: String(dto.id),
    customerId: String(dto.customer_id),
    name: dto.name,
    phone: dto.phone ?? undefined,
    email: dto.email ?? undefined,
    wechat: dto.wechat ?? undefined,
    title: dto.title ?? undefined,
    isPrimary: dto.is_primary,
    remark: dto.remark ?? undefined,
    createdAt: dto.created_at,
    updatedAt: dto.updated_at,
  }
}

export function mapDashboardStats(dto: DashboardStatsDto): DashboardStats {
  return {
    leadFunnel: dto.lead_funnel,
    newThisMonth: {
      newCustomers: dto.new_this_month.new_customers,
      newLeads: dto.new_this_month.new_leads,
      convertedCount: dto.new_this_month.converted_count,
    },
    followActivity: {
      followCount7d: dto.follow_activity.follow_count_7d,
    },
    perOwner: dto.per_owner.map((p) => ({
      ownerId: p.owner_id,
      ownerName: p.owner_name ?? undefined,
      customerCount: p.customer_count,
      convertedThisMonth: p.converted_this_month,
    })),
  }
}

/** 漏斗二层面板：阶段明细 DTO → 前端类型（BLF-518）。 */
export function mapFunnelStageDetail(dto: StageDetailDto): FunnelStageDetail {
  return {
    stage: dto.stage,
    count: dto.count,
    avgDwellDays: dto.avg_dwell_days ?? undefined,
    stuckCount: dto.stuck_count,
    inflow: dto.inflow,
    outflow: dto.outflow ?? undefined,
    stuckDays: dto.stuck_days,
    page: dto.page,
    pageSize: dto.page_size,
    total: dto.total,
    leads: dto.leads.map((l) => ({
      id: String(l.id),
      name: l.name,
      company: l.company ?? undefined,
      ownerId: l.owner_id ?? null,
      ownerName: l.owner_name ?? undefined,
      source: l.source ?? undefined,
      intent: l.intent ?? undefined,
      enteredStageAt: l.entered_stage_at ?? undefined,
      lastActionAt: l.last_action_at ?? undefined,
      lastActionContent: l.last_action_content ?? undefined,
      nextFollowAt: l.next_follow_at ?? undefined,
      dwellDays: l.dwell_days ?? undefined,
      isStuck: l.is_stuck,
    })),
  }
}

/** 生命周期看板映射（BLF-520）：snake → camel；null → undefined。 */
export function mapLifecycleDistribution(dto: LifecycleDistributionDto): LifecycleDistribution {
  return {
    metric: dto.metric as LifecycleDistribution['metric'],
    label: dto.label,
    description: dto.description,
    buckets: dto.buckets.map((b) => ({
      label: b.label,
      minDays: b.min_days,
      maxDays: b.max_days ?? undefined,
      count: b.count,
      pct: b.pct,
      cumulativePct: b.cumulative_pct,
    })),
    summary: {
      sampleCount: dto.summary.sample_count,
      totalCount: dto.summary.total_count,
      avgDays: dto.summary.avg_days ?? undefined,
      medianDays: dto.summary.median_days ?? undefined,
      p90Days: dto.summary.p90_days ?? undefined,
      maxDays: dto.summary.max_days ?? undefined,
    },
  }
}

export function mapLifecycleBoard(dto: LifecycleBoardDto): LifecycleBoard {
  return {
    firstFollow: mapLifecycleDistribution(dto.first_follow),
    conversion: mapLifecycleDistribution(dto.conversion),
    churn: mapLifecycleDistribution(dto.churn),
    nowInSea: dto.now_in_sea,
  }
}

/** 审计日志出站映射（snake → camel，int → string；可空字段保留 null）。 */
export function mapAuditLog(dto: AuditLogDto): AuditLog {
  return {
    id: String(dto.id),
    entityType: dto.entity_type as AuditLog['entityType'],
    entityId: String(dto.entity_id),
    action: dto.action as AuditLog['action'],
    actorId: dto.actor_id ?? null,
    actorName: dto.actor_name ?? null,
    summary: dto.summary ?? null,
    createdAt: dto.created_at,
  }
}

/** 任务出站映射（snake → camel，int → string；null → undefined，ownerId 保留 null）。 */
export function mapTask(dto: TaskDto): Task {
  return {
    id: String(dto.id),
    title: dto.title,
    description: dto.description ?? undefined,
    dueDate: dto.due_date ?? undefined,
    priority: dto.priority as Task['priority'],
    status: dto.status as Task['status'],
    type: dto.type as Task['type'],
    ownerId: dto.owner_id ?? null,
    ownerName: dto.owner_name ?? undefined,
    customerId: dto.customer_id != null ? String(dto.customer_id) : undefined,
    customerName: dto.customer_name ?? undefined,
    leadId: dto.lead_id != null ? String(dto.lead_id) : undefined,
    leadName: dto.lead_name ?? undefined,
    remindedAt: dto.reminded_at ?? undefined,
    createdBy: dto.created_by ?? undefined,
    completedAt: dto.completed_at ?? undefined,
    createdAt: dto.created_at,
    updatedAt: dto.updated_at,
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

/** 客户创建/更新入参。contact* 入站（后端建主联系人，修复丢失联系人 bug）。 */
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
    contact_name: input.contactName,
    contact_phone: input.contactPhone,
    contact_email: input.contactEmail,
  })
}

/** 公海导入单行入参（驼峰→下划线，剔 undefined）。 */
export function toImportRowPayload(row: CustomerSeaImportRow): Record<string, unknown> {
  return stripUndefined({
    name: row.name,
    short_name: row.shortName,
    industry: row.industry,
    customer_type: row.customerType,
    interested_service: row.interestedService,
    rating: row.rating,
    status: row.status,
    source: row.source,
    address: row.address,
    website: row.website,
    annual_revenue: row.annualRevenue,
    employee_count: row.employeeCount,
    remark: row.remark,
    contact_name: row.contactName,
    contact_phone: row.contactPhone,
    contact_email: row.contactEmail,
  })
}

/** 导入结果 DTO（下划线）→ 前端（驼峰）。 */
export function mapImportResult(dto: {
  created: number
  skipped_dupes: number
  failed: Array<{ row: number; field?: string | null; reason: string }>
}): CustomerSeaImportResult {
  return {
    created: dto.created,
    skippedDupes: dto.skipped_dupes,
    failed: dto.failed.map((f) => ({ row: f.row, field: f.field ?? undefined, reason: f.reason })),
  }
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

/** 联系人创建/更新入参。 */
export function toContactPayload(input: ContactInput): Record<string, unknown> {
  return stripUndefined({
    name: input.name,
    phone: input.phone,
    email: input.email,
    wechat: input.wechat,
    title: input.title,
    is_primary: input.isPrimary,
    remark: input.remark,
  })
}

/** 任务创建/更新入参（camel → snake；customer_id/lead_id 转 int；owner_id 保留字符串）。 */
export function toTaskPayload(input: Partial<TaskInput>): Record<string, unknown> {
  return stripUndefined({
    title: input.title,
    description: input.description,
    due_date: input.dueDate,
    priority: input.priority,
    type: input.type,
    owner_id: input.ownerId,
    customer_id: input.customerId != null ? Number(input.customerId) : input.customerId,
    lead_id: input.leadId != null ? Number(input.leadId) : input.leadId,
  })
}

// ---------- 规则引擎（P9，BLF-543/545） ----------

/** 规则 DTO → 前端 Rule（snake → camel；conditions/actions 逐项映射）。 */
export function mapRule(dto: RuleDto): Rule {
  return {
    id: dto.id,
    name: dto.name,
    description: dto.description ?? undefined,
    entityType: dto.entity_type as Rule['entityType'],
    eventType: dto.event_type as Rule['eventType'],
    enabled: dto.enabled,
    priority: dto.priority,
    conditions: (dto.conditions ?? []).map((c) => ({
      id: c.id,
      field: c.field,
      operator: c.operator as RuleCondition['operator'],
      value: c.value ?? null,
      sortOrder: c.sort_order,
    })),
    actions: (dto.actions ?? []).map((a) => ({
      id: a.id,
      actionType: a.action_type as RuleAction['actionType'],
      params: a.params ?? null,
      sortOrder: a.sort_order,
    })),
    createdBy: dto.created_by ?? undefined,
    createdAt: dto.created_at,
    updatedAt: dto.updated_at,
  }
}

/** 规则创建/更新入参（camel → snake；conditions/actions 整体替换，子表 id 省略）。 */
export function toRulePayload(input: Partial<RuleInput>): Record<string, unknown> {
  return stripUndefined({
    name: input.name,
    description: input.description,
    entity_type: input.entityType,
    event_type: input.eventType,
    enabled: input.enabled,
    priority: input.priority,
    conditions: input.conditions?.map((c) =>
      stripUndefined({
        field: c.field,
        operator: c.operator,
        value: c.value,
        sort_order: c.sortOrder,
      })
    ),
    actions: input.actions?.map((a) =>
      stripUndefined({
        action_type: a.actionType,
        params: a.params,
        sort_order: a.sortOrder,
      })
    ),
  })
}


// ---------- P9 工作流自动化设置（BLF-540） ----------
export interface WorkflowSettingsDto {
  stale_days: number
  stale_email_enabled: boolean
}

/** 工作流设置 DTO → 前端类型。 */
export function mapWorkflowSettings(dto: WorkflowSettingsDto): WorkflowSettings {
  return { staleDays: dto.stale_days, staleEmailEnabled: dto.stale_email_enabled }
}

/** 工作流设置更新入参（camel → snake；只传有值的字段）。 */
export function toWorkflowSettingsPayload(
  input: Partial<WorkflowSettings>
): Record<string, unknown> {
  return stripUndefined({
    stale_days: input.staleDays,
    stale_email_enabled: input.staleEmailEnabled,
  })
}

// ---------- 客户方案（Proposal） ----------

/** 方案版本 DTO（后端 snake_case）。 */
export interface ProposalVersionDto {
  id: number
  version_no: number
  original_filename: string
  content_type: string
  file_size: number
  change_note?: string | null
  created_by?: string | null
  created_by_name?: string | null
  created_at: string
}

/** 方案 DTO（后端 snake_case）。 */
export interface ProposalDto {
  id: number
  title: string
  proposal_type: string
  status: string
  customer_id?: number | null
  customer_name?: string | null
  owner_id?: string | null
  owner_name?: string | null
  current_version_no: number
  version_count: number
  created_by?: string | null
  created_at: string
  updated_at: string
}

export interface ProposalDetailDto extends ProposalDto {
  versions: ProposalVersionDto[]
}

export interface ProposalUploadResultDto {
  proposal: ProposalDto
  version: ProposalVersionDto
  warnings?: string[] | null
}

/** 方案版本 DTO → 前端类型（snake → camel，int → string，null → undefined）。 */
export function mapProposalVersion(dto: ProposalVersionDto): ProposalVersion {
  return {
    id: String(dto.id),
    versionNo: dto.version_no,
    originalFilename: dto.original_filename,
    contentType: dto.content_type,
    fileSize: dto.file_size,
    changeNote: dto.change_note ?? undefined,
    createdBy: dto.created_by ?? undefined,
    createdByName: dto.created_by_name ?? undefined,
    createdAt: dto.created_at,
  }
}

/** 方案 DTO → 前端类型。 */
export function mapProposal(dto: ProposalDto): Proposal {
  return {
    id: String(dto.id),
    title: dto.title,
    proposalType: dto.proposal_type as Proposal['proposalType'],
    status: dto.status as Proposal['status'],
    customerId: dto.customer_id != null ? String(dto.customer_id) : undefined,
    customerName: dto.customer_name ?? undefined,
    ownerId: dto.owner_id ?? null,
    ownerName: dto.owner_name ?? undefined,
    currentVersionNo: dto.current_version_no,
    versionCount: dto.version_count ?? 0,
    createdBy: dto.created_by ?? undefined,
    createdAt: dto.created_at,
    updatedAt: dto.updated_at,
  }
}

/** 方案详情 DTO → 前端类型（含版本链）。 */
export function mapProposalDetail(dto: ProposalDetailDto): ProposalDetail {
  return {
    ...mapProposal(dto),
    versions: (dto.versions ?? []).map(mapProposalVersion),
  }
}

/** 上传结果 DTO → 前端类型。 */
export function mapProposalUploadResult(
  dto: ProposalUploadResultDto
): ProposalUploadResult {
  return {
    proposal: mapProposal(dto.proposal),
    version: mapProposalVersion(dto.version),
    warnings: dto.warnings ?? [],
  }
}

/** customerId → 后端 int | null：空串/未传 → undefined（不动），null → null（清关联）。 */
function toNullableCustomerId(value: string | null | undefined): number | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  return Number(value)
}

/** 部分更新入参（camel → snake；只传有值的字段，customerId 空串转 null）。 */
export function toProposalPayload(
  input: Partial<ProposalUpdateInput>
): Record<string, unknown> {
  return stripUndefined({
    title: input.title,
    proposal_type: input.proposalType,
    status: input.status,
    customer_id: toNullableCustomerId(input.customerId),
  })
}

/** 新建按钮：把文件 + 元数据打成 multipart FormData（后端 Form/File 字段）。 */
export function toProposalCreateFormData(input: ProposalCreateInput): FormData {
  const fd = new FormData()
  fd.append('file', input.file)
  if (input.title) fd.append('title', input.title)
  if (input.proposalType) fd.append('proposal_type', input.proposalType)
  if (input.customerId) fd.append('customer_id', String(input.customerId))
  if (input.changeNote) fd.append('change_note', input.changeNote)
  return fd
}

/** 追加版本：multipart FormData。 */
export function toProposalVersionFormData(input: ProposalVersionInput): FormData {
  const fd = new FormData()
  fd.append('file', input.file)
  if (input.changeNote) fd.append('change_note', input.changeNote)
  return fd
}

/** 预览内容 DTO → 前端类型。 */
export function mapProposalContent(dto: {
  proposal_id: number
  version_no: number
  title: string
  content: string
}): ProposalContent {
  return {
    proposalId: String(dto.proposal_id),
    versionNo: dto.version_no,
    title: dto.title,
    content: dto.content,
  }
}
