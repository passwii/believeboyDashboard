import type { CrmClient, ListParams, Paginated } from './crm-client'
import type {
  AuditLog,
  AuditLogQuery,
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
  FollowEntityType,
  FollowInput,
  FollowUpGroups,
  FunnelStageDetail,
  FunnelStageQuery,
  Lead,
  LeadInput,
  LifecycleBoard,
  Task,
  TaskInput,
  TaskListParams,
  TaskStatus,
  Rule,
  RuleInput,
  User,
  ValueScoresInput,
  WorkflowSettings,
} from '@/lib/crm/types'
import {
  mapAuditLog,
  mapCategory,
  mapContact,
  mapCustomer,
  mapDashboardStats,
  mapFollow,
  mapFollowUpGroups,
  mapFunnelStageDetail,
  mapImportResult,
  mapLead,
  mapLifecycleBoard,
  mapTask,
  mapRule,
  mapUser,
  mapWorkflowSettings,
  toCategoryPayload,
  toContactPayload,
  toConvertPayload,
  toCustomerPayload,
  toFollowPayload,
  toImportRowPayload,
    toLeadPayload,
    toTaskPayload,
    toRulePayload,
    toWorkflowSettingsPayload,
  type AuditLogDto,
  type CategoryDto,
  type ContactDto,
  type CustomerDto,
  type DashboardStatsDto,
  type FollowDto,
  type FollowUpGroupsDto,
  type RuleDto,
  type StageDetailDto,
  type LeadDto,
  type LifecycleBoardDto,
  type TaskDto,
  type UserDto,
  type WorkflowSettingsDto,
} from './dto-mappers'

/**
 * 真实后端 CRM 客户端。
 *
 * 经 Next 代理 `/api/backend/v1/crm/...` 访问（代理注入 X-API-Key/X-User-Id 等
 * 鉴权头，见 app/api/backend/[...path]/route.ts），客户端只设 Content-Type。
 * 切换：`NEXT_PUBLIC_CRM_API_MODE=http`（见 crm-client-provider.tsx）。
 */
const BASE = '/api/backend/v1/crm'

interface ListResponseDto<TDto> {
  items: TDto[]
  total: number
  page: number
  page_size: number
}

/**
 * 带 HTTP status 的请求错误（P5-11）。
 * 调用方按 status 区分 401/403/5xx/network 给用户精确提示，而不是一律「无权限」。
 */
export class ApiError extends Error {
  status: number
  body: unknown
  constructor(status: number, message: string, body?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    })
  } catch (e) {
    // 网络层错误（断网/CORS/abort）—— 抛不带 status 的 Error，让 catch 区分 network vs HTTP
    throw new Error(`网络错误：${(e as Error)?.message ?? String(e)}`)
  }
  if (!res.ok) {
    let body: unknown = undefined
    let message = `CRM 请求失败（${res.status}）`
    try {
      body = await res.json()
      if (typeof body === 'object' && body !== null) {
        const detail = (body as { detail?: unknown }).detail
        if (typeof detail === 'string') message = detail
        else if (detail) message = JSON.stringify(detail)
        else if (typeof (body as { message?: unknown }).message === 'string') {
          message = (body as { message: string }).message
        }
      }
    } catch {
      // 非 JSON 错误体，保留默认消息
    }
    throw new ApiError(res.status, message, body)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/** ListParams → 后端 query string。filters（高级筛选）序列化为 JSON 数组入站（Task B2 后端支持）。 */
function toQueryString(params: ListParams): string {
  const qs = new URLSearchParams()
  if (params.scope) qs.set('scope', params.scope)
  if (params.keyword) qs.set('keyword', params.keyword)
  if (params.page != null) qs.set('page', String(params.page))
  if (params.pageSize != null) qs.set('page_size', String(params.pageSize))
  if (params.sortBy) qs.set('sort_by', params.sortBy)
  if (params.sortOrder) qs.set('sort_order', params.sortOrder)
  if (params.filters && params.filters.length > 0) {
    qs.set('filters', JSON.stringify(params.filters))
  }
  const s = qs.toString()
  return s ? `?${s}` : ''
}

/** 列表参数 → 后端 query string（P5-9 支持 entity_types / entity_ids 多值）。 */
function toAuditQueryString(params: AuditLogQuery): string {
  const qs = new URLSearchParams()
  if (params.entityTypes && params.entityTypes.length > 0) {
    params.entityTypes.forEach((t) => qs.append('entity_types', t))
  } else if (params.entityType) {
    qs.set('entity_type', params.entityType)
  }
  if (params.entityIds && params.entityIds.length > 0) {
    params.entityIds.forEach((id) => qs.append('entity_ids', String(id)))
  } else if (params.entityId) {
    qs.set('entity_id', params.entityId)
  }
  if (params.actorId) qs.set('actor_id', params.actorId)
  if (params.action) qs.set('action', params.action)
  qs.set('page', String(params.page ?? 1))
  qs.set('page_size', String(params.pageSize ?? 20))
  return `?${qs.toString()}`
}

function mapPage<TDto, T>(dto: ListResponseDto<TDto>, map: (d: TDto) => T): Paginated<T> {
  return { items: dto.items.map(map), total: dto.total, page: dto.page, pageSize: dto.page_size }
}

/** 任务列表参数 → 后端 query string（白名单筛选字段直接透传）。 */
function toTaskQueryString(params: TaskListParams): string {
  const qs = new URLSearchParams()
  if (params.scope) qs.set('scope', params.scope)
  if (params.type) qs.set('type', params.type)
  if (params.status) qs.set('status', params.status)
  if (params.priority) qs.set('priority', params.priority)
  if (params.ownerId) qs.set('owner_id', params.ownerId)
  if (params.customerId) qs.set('customer_id', params.customerId)
  if (params.leadId) qs.set('lead_id', params.leadId)
  if (params.page != null) qs.set('page', String(params.page))
  if (params.pageSize != null) qs.set('page_size', String(params.pageSize))
  if (params.sortBy) qs.set('sort_by', params.sortBy)
  if (params.sortOrder) qs.set('sort_order', params.sortOrder)
  const s = qs.toString()
  return s ? `?${s}` : ''
}

export class HttpCrmClient implements CrmClient {
  // ===== Customer =====
  async listCustomers(params: ListParams): Promise<Paginated<Customer>> {
    const dto = await request<ListResponseDto<CustomerDto>>(`/customers${toQueryString(params)}`)
    return mapPage(dto, mapCustomer)
  }
  async getCustomer(id: string): Promise<Customer> {
    return mapCustomer(await request<CustomerDto>(`/customers/${id}`))
  }
  async createCustomer(input: CustomerInput): Promise<Customer> {
    return mapCustomer(
      await request<CustomerDto>('/customers', {
        method: 'POST',
        body: JSON.stringify(toCustomerPayload(input)),
      })
    )
  }
  async updateCustomer(id: string, input: Partial<CustomerInput>): Promise<Customer> {
    return mapCustomer(
      await request<CustomerDto>(`/customers/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(toCustomerPayload(input)),
      })
    )
  }
  async updateValueScores(id: string, input: ValueScoresInput): Promise<Customer> {
    return mapCustomer(
      await request<CustomerDto>(`/customers/${id}/value-scores`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      })
    )
  }
  async setCustomerCategories(
    id: string,
    categoryIds: string[]
  ): Promise<Customer> {
    return mapCustomer(
      await request<CustomerDto>(`/customers/${id}/categories`, {
        method: 'PUT',
        body: JSON.stringify({ category_ids: categoryIds.map(Number) }),
      })
    )
  }
  async deleteCustomer(id: string): Promise<void> {
    await request<void>(`/customers/${id}`, { method: 'DELETE' })
  }
  async batchTransferCustomers(ids: string[], toOwnerId: string): Promise<void> {
    await request<void>('/customers/batch-transfer', {
      method: 'POST',
      body: JSON.stringify({ ids: ids.map(Number), to_owner_id: toOwnerId }),
    })
  }
  async batchMoveToSea(ids: string[]): Promise<void> {
    await request<void>('/customers/batch-move-sea', {
      method: 'POST',
      body: JSON.stringify({ ids: ids.map(Number) }),
    })
  }
  async claimFromSea(id: string): Promise<Customer> {
    return mapCustomer(await request<CustomerDto>(`/customers/${id}/claim`, { method: 'POST' }))
  }
  async importCustomersToSea(rows: CustomerSeaImportRow[]): Promise<CustomerSeaImportResult> {
    const dto = await request<{
      created: number
      skipped_dupes: number
      failed: Array<{ row: number; field?: string | null; reason: string }>
    }>('/customers/import-sea', {
      method: 'POST',
      body: JSON.stringify({ rows: rows.map(toImportRowPayload) }),
    })
    return mapImportResult(dto)
  }

  // ===== Lead =====
  async listLeads(params: ListParams): Promise<Paginated<Lead>> {
    const dto = await request<ListResponseDto<LeadDto>>(`/leads${toQueryString(params)}`)
    return mapPage(dto, mapLead)
  }
  async getLead(id: string): Promise<Lead> {
    return mapLead(await request<LeadDto>(`/leads/${id}`))
  }
  async createLead(input: LeadInput): Promise<Lead> {
    return mapLead(
      await request<LeadDto>('/leads', {
        method: 'POST',
        body: JSON.stringify(toLeadPayload(input)),
      })
    )
  }
  async updateLead(id: string, input: Partial<LeadInput>): Promise<Lead> {
    return mapLead(
      await request<LeadDto>(`/leads/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(toLeadPayload(input)),
      })
    )
  }
  async convertLead(
    id: string,
    customerInput?: Partial<CustomerInput>
  ): Promise<{ lead: Lead; customer: Customer }> {
    const payload = toConvertPayload(customerInput)
    const dto = await request<{ lead: LeadDto; customer: CustomerDto }>(`/leads/${id}/convert`, {
      method: 'POST',
      body: JSON.stringify(payload ?? {}),
    })
    return { lead: mapLead(dto.lead), customer: mapCustomer(dto.customer) }
  }

  // ===== Follow =====
  async listFollows(entityType: FollowEntityType, entityId: string): Promise<Follow[]> {
    const dtos = await request<FollowDto[]>(
      `/follows?entity_type=${encodeURIComponent(entityType)}&entity_id=${encodeURIComponent(entityId)}`
    )
    return dtos.map(mapFollow)
  }
  async createFollow(input: FollowInput): Promise<Follow> {
    return mapFollow(
      await request<FollowDto>('/follows', {
        method: 'POST',
        body: JSON.stringify(toFollowPayload(input)),
      })
    )
  }
  async listFollowUps(scope: 'mine' | 'all' = 'mine'): Promise<FollowUpGroups> {
    return mapFollowUpGroups(await request<FollowUpGroupsDto>(`/follow-ups?scope=${scope}`))
  }

  // ===== Contact =====
  async listContacts(customerId: string): Promise<Contact[]> {
    return (await request<ContactDto[]>(`/customers/${customerId}/contacts`)).map(mapContact)
  }
  async createContact(customerId: string, input: ContactInput): Promise<Contact> {
    return mapContact(
      await request<ContactDto>(`/customers/${customerId}/contacts`, {
        method: 'POST',
        body: JSON.stringify(toContactPayload(input)),
      })
    )
  }
  async updateContact(id: string, input: ContactInput): Promise<Contact> {
    return mapContact(
      await request<ContactDto>(`/contacts/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(toContactPayload(input)),
      })
    )
  }
  async deleteContact(id: string): Promise<void> {
    await request<void>(`/contacts/${id}`, { method: 'DELETE' })
  }

  // ===== User =====
  async listUsers(): Promise<User[]> {
    return (await request<UserDto[]>('/users')).map(mapUser)
  }
  async getUser(id: string): Promise<User> {
    return mapUser(await request<UserDto>(`/users/${id}`))
  }

  // ===== P6b 产品类目 =====
  async listCategories(): Promise<Category[]> {
    const dto = await request<CategoryDto[]>('/categories')
    return dto.map(mapCategory)
  }
  async createCategory(input: CategoryInput): Promise<Category> {
    return mapCategory(
      await request<CategoryDto>('/categories', {
        method: 'POST',
        body: JSON.stringify(toCategoryPayload(input)),
      })
    )
  }
  async updateCategory(
    id: string,
    input: Partial<CategoryInput>
  ): Promise<Category> {
    return mapCategory(
      await request<CategoryDto>(`/categories/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(toCategoryPayload(input)),
      })
    )
  }
  async deleteCategory(id: string): Promise<void> {
    await request<void>(`/categories/${id}`, { method: 'DELETE' })
  }

  // ===== Dashboard 数据看板（P3c） =====
  async getDashboardStats(): Promise<DashboardStats> {
    return mapDashboardStats(await request<DashboardStatsDto>('/dashboard/stats'))
  }

  // ===== 漏斗二层复盘面板（P8，BLF-518） =====
  async getFunnelStageDetail(params: FunnelStageQuery): Promise<FunnelStageDetail> {
    const qs = new URLSearchParams()
    qs.set('sort_by', params.sortBy ?? 'dwell')
    qs.set('stuck_days', String(params.stuckDays ?? 7))
    if (params.page != null) qs.set('page', String(params.page))
    if (params.pageSize != null) qs.set('page_size', String(params.pageSize))
    return mapFunnelStageDetail(
      await request<StageDetailDto>(`/dashboard/funnel/stage/${params.stage}?${qs.toString()}`)
    )
  }

  // ===== 生命周期看板（P8，BLF-520） =====
  async getLifecycleBoard(): Promise<LifecycleBoard> {
    return mapLifecycleBoard(await request<LifecycleBoardDto>('/dashboard/lifecycle'))
  }

  // ===== Audit Log 操作审计日志（P4 + P5-9/P5-11） =====
  async listAuditLogs(params: AuditLogQuery): Promise<Paginated<AuditLog>> {
    const dto = await request<ListResponseDto<AuditLogDto>>(
      `/audit-logs${toAuditQueryString(params)}`
    )
    return mapPage(dto, mapAuditLog)
  }

  // ===== Task（P7，BLF-512） =====
  async listTasks(params: TaskListParams): Promise<Paginated<Task>> {
    const dto = await request<ListResponseDto<TaskDto>>(`/tasks${toTaskQueryString(params)}`)
    return mapPage(dto, mapTask)
  }
  async setTaskStatus(id: string, status: TaskStatus): Promise<Task> {
    return mapTask(
      await request<TaskDto>(`/tasks/${id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      })
    )
  }

  // ===== Task 创建/编辑/完成/取消（P7，BLF-514） =====
  async createTask(input: TaskInput): Promise<Task> {
    return mapTask(
      await request<TaskDto>('/tasks', {
        method: 'POST',
        body: JSON.stringify(toTaskPayload(input)),
      })
    )
  }
  async updateTask(id: string, input: Partial<TaskInput>): Promise<Task> {
    return mapTask(
      await request<TaskDto>(`/tasks/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(toTaskPayload(input)),
      })
    )
  }
  async completeTask(id: string): Promise<Task> {
    return mapTask(await request<TaskDto>(`/tasks/${id}/complete`, { method: 'POST' }))
  }
  async cancelTask(id: string): Promise<Task> {
    return mapTask(await request<TaskDto>(`/tasks/${id}/cancel`, { method: 'POST' }))
  }

  // ===== 规则引擎（P9，BLF-543/545） =====
  async listRules(): Promise<Rule[]> {
    const dtos = await request<RuleDto[]>('/rules')
    return dtos.map(mapRule)
  }
  async createRule(input: RuleInput): Promise<Rule> {
    return mapRule(
      await request<RuleDto>('/rules', {
        method: 'POST',
        body: JSON.stringify(toRulePayload(input)),
      })
    )
  }
  async updateRule(id: number, input: Partial<RuleInput>): Promise<Rule> {
    return mapRule(
      await request<RuleDto>(`/rules/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(toRulePayload(input)),
      })
    )
  }
  async deleteRule(id: number): Promise<void> {
    await request<void>(`/rules/${id}`, { method: 'DELETE' })
  }

  // ===== P9 工作流自动化设置（BLF-540） =====
  async getWorkflowSettings(): Promise<WorkflowSettings> {
    return mapWorkflowSettings(await request<WorkflowSettingsDto>('/settings/workflow'))
  }
  async updateWorkflowSettings(input: Partial<WorkflowSettings>): Promise<WorkflowSettings> {
    return mapWorkflowSettings(
      await request<WorkflowSettingsDto>('/settings/workflow', {
        method: 'PUT',
        body: JSON.stringify(toWorkflowSettingsPayload(input)),
      })
    )
  }
}