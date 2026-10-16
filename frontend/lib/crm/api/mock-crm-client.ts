import type { CrmClient, FilterCondition, ListParams, Paginated } from './crm-client'
import type {
  AuditLog,
  AuditLogQuery,
  Category,
  CategoryInput,
  Contact,
  ContactInput,
  Customer,
  CustomerInput,
  CustomerSeaImportFailItem,
  CustomerSeaImportRow,
  CustomerSeaImportResult,
  DashboardStats,
  Follow,
  FollowEntityType,
  FollowInput,
  FollowUpGroups,
  FollowUpItem,
  FunnelStageDetail,
  FunnelStageQuery,
  Lead,
  LeadInput,
  LifecycleBoard,
  LifecycleDistribution,
  Proposal,
  ProposalContent,
  ProposalCreateInput,
  ProposalDetail,
  ProposalListParams,
  ProposalUpdateInput,
  ProposalUploadResult,
  ProposalVersion,
  ProposalVersionInput,
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
import { computeRating } from '@/lib/crm/constants/value-score'
import {
  CATEGORIES_FIXTURE,
  CUSTOMERS_FIXTURE,
  LEADS_FIXTURE,
  FOLLOWS_FIXTURE,
  TASKS_FIXTURE,
  RULES_FIXTURE,
  USERS_FIXTURE,
  PROPOSALS_FIXTURE,
  PROPOSAL_VERSIONS_FIXTURE,
  mockProposalHtml,
} from './mock-data'

const STORAGE_KEY = 'believeboy-crm-mock-state-v1'
const LATENCY_MIN = 150
const LATENCY_MAX = 400
const E2E_LATENCY_MS = 200
const ERROR_RATE = 0.05

const DEFAULT_WORKFLOW_SETTINGS: WorkflowSettings = {
  staleDays: 7,
  staleEmailEnabled: true,
}

interface MockState {
  customers: Customer[]
  leads: Lead[]
  follows: Follow[]
  contacts: Contact[]
  users: User[]
  categories: Category[]
  audits: AuditLog[]
  tasks: Task[]
  rules: Rule[]
  proposals: Proposal[]
  /** 版本元数据（扁平存放，按 proposalId 过滤）。 */
  proposalVersions: ProposalVersion[]
  /** mock 预览/下载正文：`${proposalId}:${versionNo}` → 适配后的 HTML。 */
  proposalBodies: Record<string, string>
  workflowSettings: WorkflowSettings
}

function isE2E(): boolean {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('e2e')
}

function isDev(): boolean {
  return process.env.NODE_ENV !== 'production'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function randomLatency(): number {
  if (isE2E()) return E2E_LATENCY_MS
  return LATENCY_MIN + Math.random() * (LATENCY_MAX - LATENCY_MIN)
}

function maybeFail(op: string): void {
  if (!isDev()) return
  if (typeof window === 'undefined') return
  if (!new URLSearchParams(window.location.search).has('crmError')) return
  if (Math.random() < ERROR_RATE) {
    throw new Error(`[mock-crm] simulated failure: ${op}`)
  }
}

function loadState(): MockState {
  if (typeof window === 'undefined') {
    return {
      customers: [...CUSTOMERS_FIXTURE],
      leads: [...LEADS_FIXTURE],
      follows: [...FOLLOWS_FIXTURE],
      contacts: [],
      users: [...USERS_FIXTURE],
      categories: [...CATEGORIES_FIXTURE],
      audits: [],
      tasks: [...TASKS_FIXTURE],
      rules: [...RULES_FIXTURE],
      proposals: [...PROPOSALS_FIXTURE],
      proposalVersions: [...PROPOSAL_VERSIONS_FIXTURE],
      proposalBodies: {},
      workflowSettings: { ...DEFAULT_WORKFLOW_SETTINGS },
    }
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return {
        customers: [...CUSTOMERS_FIXTURE],
        leads: [...LEADS_FIXTURE],
        follows: [...FOLLOWS_FIXTURE],
        contacts: [],
        users: [...USERS_FIXTURE],
        categories: [...CATEGORIES_FIXTURE],
        audits: [],
        tasks: [...TASKS_FIXTURE],
        rules: [...RULES_FIXTURE],
        proposals: [...PROPOSALS_FIXTURE],
        proposalVersions: [...PROPOSAL_VERSIONS_FIXTURE],
        proposalBodies: {},
        workflowSettings: { ...DEFAULT_WORKFLOW_SETTINGS },
      }
    }
    const parsed = JSON.parse(raw) as Partial<MockState>
    return {
      customers: parsed.customers ?? [...CUSTOMERS_FIXTURE],
      leads: parsed.leads ?? [...LEADS_FIXTURE],
      follows: parsed.follows ?? [...FOLLOWS_FIXTURE],
      contacts: parsed.contacts ?? [],
      users: parsed.users ?? [...USERS_FIXTURE],
      categories: parsed.categories ?? [...CATEGORIES_FIXTURE],
      audits: parsed.audits ?? [],
      tasks: parsed.tasks ?? [...TASKS_FIXTURE],
      rules: parsed.rules ?? [...RULES_FIXTURE],
      proposals: parsed.proposals ?? [...PROPOSALS_FIXTURE],
      proposalVersions: parsed.proposalVersions ?? [...PROPOSAL_VERSIONS_FIXTURE],
      proposalBodies: parsed.proposalBodies ?? {},
      workflowSettings: parsed.workflowSettings ?? { ...DEFAULT_WORKFLOW_SETTINGS },
    }
  } catch {
    return {
      customers: [...CUSTOMERS_FIXTURE],
      leads: [...LEADS_FIXTURE],
      follows: [...FOLLOWS_FIXTURE],
      contacts: [],
      users: [...USERS_FIXTURE],
      categories: [...CATEGORIES_FIXTURE],
      audits: [],
      tasks: [...TASKS_FIXTURE],
      rules: [...RULES_FIXTURE],
      proposals: [...PROPOSALS_FIXTURE],
      proposalVersions: [...PROPOSAL_VERSIONS_FIXTURE],
      proposalBodies: {},
      workflowSettings: { ...DEFAULT_WORKFLOW_SETTINGS },
    }
  }
}

function persistState(state: MockState): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // localStorage 容量超限等情况下静默忽略
  }
}

function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function evaluateCondition(condition: FilterCondition, row: Record<string, unknown>): boolean {
  if ('and' in condition) {
    return condition.and.every((c) => evaluateCondition(c, row))
  }
  if ('or' in condition) {
    return condition.or.some((c) => evaluateCondition(c, row))
  }
  const { field, op, value } = condition
  const v = row[field]
  switch (op) {
    case 'eq':
      return v === value
    case 'neq':
      return v !== value
    case 'contains':
      if (typeof v === 'string' && typeof value === 'string') return v.includes(value)
      return false
    case 'gt':
      if (typeof v === 'number' && typeof value === 'number') return v > value
      if (typeof v === 'string' && typeof value === 'string') return v > value
      return false
    case 'lt':
      if (typeof v === 'number' && typeof value === 'number') return v < value
      if (typeof v === 'string' && typeof value === 'string') return v < value
      return false
    case 'between':
      if (!Array.isArray(value) || value.length !== 2) return false
      const [lo, hi] = value as [unknown, unknown]
      if (typeof v === 'number' && typeof lo === 'number' && typeof hi === 'number') {
        return v >= lo && v <= hi
      }
      return false
    case 'in':
      if (!Array.isArray(value)) return false
      return value.includes(v)
    case 'is_null':
      return v === null || v === undefined || v === ''
    case 'is_not_null':
      return v !== null && v !== undefined && v !== ''
    default:
      return true
  }
}

function applyFilters<T>(items: T[], filters?: FilterCondition[]): T[] {
  if (!filters || filters.length === 0) return items
  return items.filter((item) =>
    filters.every((c) => evaluateCondition(c, item as Record<string, unknown>))
  )
}

function applyKeyword<T>(items: T[], keyword?: string, keys: (keyof T)[] = []): T[] {
  if (!keyword) return items
  const k = keyword.toLowerCase()
  return items.filter((item) =>
    keys.some((key) => {
      const v = item[key]
      return typeof v === 'string' && v.toLowerCase().includes(k)
    })
  )
}

function applyScope<T>(
  items: T[],
  scope: ListParams['scope'],
  currentUserId: string | null,
  ownerKey: keyof T
): T[] {
  if (scope === 'sea') return items.filter((item) => item[ownerKey] === null)
  if (scope !== 'mine' || !currentUserId) return items
  return items.filter((item) => item[ownerKey] === currentUserId)
}

function applySort<T>(
  items: T[],
  sortBy: string | undefined,
  sortOrder: 'asc' | 'desc' | undefined
): T[] {
  if (!sortBy) return items
  const order = sortOrder === 'desc' ? -1 : 1
  return [...items].sort((a, b) => {
    const av = (a as Record<string, unknown>)[sortBy]
    const bv = (b as Record<string, unknown>)[sortBy]
    if (av === bv) return 0
    if (av === undefined) return 1
    if (bv === undefined) return -1
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * order
    return String(av).localeCompare(String(bv)) * order
  })
}

function paginate<T>(items: T[], page = 1, pageSize = 20): Paginated<T> {
  const start = (page - 1) * pageSize
  return {
    items: items.slice(start, start + pageSize),
    total: items.length,
    page,
    pageSize,
  }
}

export class MockCrmClient implements CrmClient {
  private state: MockState
  private currentUserId: string

  constructor(currentUserId = 'u-001') {
    this.state = loadState()
    this.currentUserId = currentUserId
  }

  setCurrentUserId(userId: string): void {
    this.currentUserId = userId
  }

  private async delay(op: string): Promise<void> {
    maybeFail(op)
    await sleep(randomLatency())
  }

  // ===== Customer =====

  async listCustomers(params: ListParams): Promise<Paginated<Customer>> {
    await this.delay('listCustomers')
    const filtered = applyScope(this.state.customers, params.scope, this.currentUserId, 'ownerId')
    const keywordFiltered = applyKeyword(filtered, params.keyword, [
      'name',
      'shortName',
      'contactName',
      'contactPhone',
    ])
    const filterFiltered = applyFilters(keywordFiltered, params.filters)
    const sorted = applySort(filterFiltered, params.sortBy, params.sortOrder)
    return paginate(sorted, params.page, params.pageSize)
  }

  async getCustomer(id: string): Promise<Customer> {
    await this.delay('getCustomer')
    const c = this.state.customers.find((x) => x.id === id)
    if (!c) throw new Error(`客户不存在: ${id}`)
    return c
  }

  async createCustomer(input: CustomerInput): Promise<Customer> {
    await this.delay('createCustomer')
    const now = new Date().toISOString()
    const id = genId('c')
    const owner = input.ownerId ? this.state.users.find((u) => u.id === input.ownerId) : null
    const customer: Customer = {
      ...input,
      id,
      ownerId: input.ownerId ?? this.currentUserId,
      ownerName: owner?.name,
      categories: [],
      createdAt: now,
      updatedAt: now,
      createdBy: this.currentUserId,
    }
    this.state.customers.unshift(customer)
    persistState(this.state)
    return customer
  }

  async importCustomersToSea(rows: CustomerSeaImportRow[]): Promise<CustomerSeaImportResult> {
    await this.delay('importCustomersToSea')
    let created = 0
    let skippedDupes = 0
    const failed: CustomerSeaImportFailItem[] = []
    const seen = new Set<string>()
    const normPhone = (s?: string) => (s ?? '').replace(/[ -]/g, '')
    rows.forEach((row, i) => {
      const name = (row.name ?? '').trim()
      if (!name) {
        failed.push({ row: i + 1, field: 'name', reason: '客户名必填' })
        return
      }
      const key = `${name.toLowerCase()}|${normPhone(row.contactPhone)}`
      const dup =
        seen.has(key) ||
        this.state.customers.some(
          (c) => c.name.trim().toLowerCase() === name.toLowerCase() && !c.ownerId
        )
      if (dup) {
        skippedDupes += 1
        seen.add(key)
        return
      }
      seen.add(key)
      const now = new Date().toISOString()
      const imported: Customer = {
        id: genId('c'),
        name,
        shortName: row.shortName,
        industry: row.industry,
        customerType: row.customerType,
        interestedService: row.interestedService,
        rating: (row.rating as Customer['rating']) ?? 'C',
        categories: [],
        status: (row.status as Customer['status']) ?? 'active',
        source: (row.source as Customer['source']) ?? 'other',
        ownerId: null,
        contactName: row.contactName,
        contactPhone: row.contactPhone,
        contactEmail: row.contactEmail,
        address: row.address,
        website: row.website,
        annualRevenue: row.annualRevenue,
        employeeCount: row.employeeCount,
        remark: row.remark,
        createdBy: this.currentUserId,
        createdAt: now,
        updatedAt: now,
      }
      this.state.customers.unshift(imported)
      created += 1
    })
    persistState(this.state)
    return { created, skippedDupes, failed }
  }

  async updateCustomer(id: string, input: Partial<CustomerInput>): Promise<Customer> {
    await this.delay('updateCustomer')
    const idx = this.state.customers.findIndex((c) => c.id === id)
    if (idx === -1) throw new Error(`客户不存在: ${id}`)
    const prev = this.state.customers[idx]
    const owner =
      input.ownerId !== undefined
        ? (this.state.users.find((u) => u.id === input.ownerId) ?? null)
        : null
    const updated: Customer = {
      ...prev,
      ...input,
      ownerName: input.ownerId !== undefined ? owner?.name : prev.ownerName,
      updatedAt: new Date().toISOString(),
    }
    this.state.customers[idx] = updated
    persistState(this.state)
    return updated
  }

  async updateValueScores(id: string, input: ValueScoresInput): Promise<Customer> {
    await this.delay('updateValueScores')
    const idx = this.state.customers.findIndex((c) => c.id === id)
    if (idx === -1) throw new Error(`客户不存在: ${id}`)
    const prev = this.state.customers[idx]
    const scores = {
      score_scale: input.score_scale ?? prev.scoreScale ?? null,
      score_pay: input.score_pay ?? prev.scorePay ?? null,
      score_fit: input.score_fit ?? prev.scoreFit ?? null,
      score_coop: input.score_coop ?? prev.scoreCoop ?? null,
    }
    const newRating = computeRating(scores)
    const updated: Customer = {
      ...prev,
      scoreScale: scores.score_scale,
      scorePay: scores.score_pay,
      scoreFit: scores.score_fit,
      scoreCoop: scores.score_coop,
      rating: newRating ?? prev.rating,
      updatedAt: new Date().toISOString(),
    }
    this.state.customers[idx] = updated
    persistState(this.state)
    return updated
  }

  async setCustomerCategories(
    id: string,
    categoryIds: string[]
  ): Promise<Customer> {
    await this.delay('setCustomerCategories')
    const idx = this.state.customers.findIndex((c) => c.id === id)
    if (idx === -1) throw new Error(`客户不存在: ${id}`)
    const cats = this.state.categories.filter((c) => categoryIds.includes(c.id))
    const updated: Customer = {
      ...this.state.customers[idx],
      categories: cats,
      updatedAt: new Date().toISOString(),
    }
    this.state.customers[idx] = updated
    persistState(this.state)
    return updated
  }

  async deleteCustomer(id: string): Promise<void> {
    await this.delay('deleteCustomer')
    const idx = this.state.customers.findIndex((c) => c.id === id)
    if (idx === -1) throw new Error(`客户不存在: ${id}`)
    this.state.customers.splice(idx, 1)
    this.state.follows = this.state.follows.filter(
      (f) => !(f.entityType === 'customer' && f.entityId === id)
    )
    persistState(this.state)
  }

  async batchTransferCustomers(ids: string[], toOwnerId: string): Promise<void> {
    await this.delay('batchTransferCustomers')
    const owner = this.state.users.find((u) => u.id === toOwnerId)
    if (!owner) throw new Error(`目标负责人不存在: ${toOwnerId}`)
    const now = new Date().toISOString()
    this.state.customers = this.state.customers.map((c) =>
      ids.includes(c.id) ? { ...c, ownerId: toOwnerId, ownerName: owner.name, updatedAt: now } : c
    )
    persistState(this.state)
  }

  async batchMoveToSea(ids: string[]): Promise<void> {
    await this.delay('batchMoveToSea')
    const now = new Date().toISOString()
    this.state.customers = this.state.customers.map((c) =>
      ids.includes(c.id) ? { ...c, ownerId: null, ownerName: undefined, updatedAt: now } : c
    )
    persistState(this.state)
  }

  async claimFromSea(id: string): Promise<Customer> {
    await this.delay('claimFromSea')
    const idx = this.state.customers.findIndex((c) => c.id === id)
    if (idx === -1) throw new Error(`客户不存在: ${id}`)
    const prev = this.state.customers[idx]
    const owner = this.state.users.find((u) => u.id === this.currentUserId)
    const updated: Customer = {
      ...prev,
      ownerId: this.currentUserId,
      ownerName: owner?.name,
      updatedAt: new Date().toISOString(),
    }
    this.state.customers[idx] = updated
    persistState(this.state)
    return updated
  }

  // ===== Lead =====

  async listLeads(params: ListParams): Promise<Paginated<Lead>> {
    await this.delay('listLeads')
    const filtered = applyScope(this.state.leads, params.scope, this.currentUserId, 'ownerId')
    const keywordFiltered = applyKeyword(filtered, params.keyword, [
      'name',
      'company',
      'phone',
      'email',
    ])
    const filterFiltered = applyFilters(keywordFiltered, params.filters)
    const sorted = applySort(filterFiltered, params.sortBy, params.sortOrder)
    return paginate(sorted, params.page, params.pageSize)
  }

  async getLead(id: string): Promise<Lead> {
    await this.delay('getLead')
    const l = this.state.leads.find((x) => x.id === id)
    if (!l) throw new Error(`线索不存在: ${id}`)
    return l
  }

  async createLead(input: LeadInput): Promise<Lead> {
    await this.delay('createLead')
    const now = new Date().toISOString()
    const id = genId('l')
    const owner = input.ownerId ? this.state.users.find((u) => u.id === input.ownerId) : null
    const lead: Lead = {
      ...input,
      id,
      ownerId: input.ownerId ?? this.currentUserId,
      ownerName: owner?.name,
      createdAt: now,
      updatedAt: now,
    }
    this.state.leads.unshift(lead)
    persistState(this.state)
    return lead
  }

  async updateLead(id: string, input: Partial<LeadInput>): Promise<Lead> {
    await this.delay('updateLead')
    const idx = this.state.leads.findIndex((l) => l.id === id)
    if (idx === -1) throw new Error(`线索不存在: ${id}`)
    const prev = this.state.leads[idx]
    const owner =
      input.ownerId !== undefined ? this.state.users.find((u) => u.id === input.ownerId) : null
    const updated: Lead = {
      ...prev,
      ...input,
      ownerName: input.ownerId !== undefined ? owner?.name : prev.ownerName,
      updatedAt: new Date().toISOString(),
    }
    this.state.leads[idx] = updated
    persistState(this.state)
    return updated
  }

  async convertLead(
    id: string,
    customerInput?: Partial<CustomerInput>
  ): Promise<{ lead: Lead; customer: Customer }> {
    await this.delay('convertLead')
    const leadIdx = this.state.leads.findIndex((l) => l.id === id)
    if (leadIdx === -1) throw new Error(`线索不存在: ${id}`)
    const lead = this.state.leads[leadIdx]
    if (lead.convertedToCustomerId) throw new Error(`线索已转化: ${id}`)
    const now = new Date().toISOString()
    const customerId = genId('c')
    const owner = lead.ownerId ? this.state.users.find((u) => u.id === lead.ownerId) : null
    const customer: Customer = {
      id: customerId,
      name: customerInput?.name ?? lead.company ?? `${lead.name}（来源线索）`,
      shortName: customerInput?.shortName ?? lead.company?.slice(0, 4),
      industry: customerInput?.industry,
      rating: customerInput?.rating ?? 'B',
      categories: [],
      status: customerInput?.status ?? 'active',
      source: lead.source,
      ownerId: lead.ownerId,
      ownerName: owner?.name,
      contactName: customerInput?.contactName ?? lead.name,
      contactPhone: customerInput?.contactPhone ?? lead.phone,
      contactEmail: customerInput?.contactEmail ?? lead.email,
      address: customerInput?.address,
      website: customerInput?.website,
      annualRevenue: customerInput?.annualRevenue,
      employeeCount: customerInput?.employeeCount,
      remark: customerInput?.remark ?? lead.remark,
      createdAt: now,
      updatedAt: now,
      createdBy: this.currentUserId,
      lastFollowAt: now,
    }
    const updatedLead: Lead = {
      ...lead,
      status: 'converted',
      convertedToCustomerId: customerId,
      convertedAt: now,
      updatedAt: now,
    }
    this.state.leads[leadIdx] = updatedLead
    this.state.customers.unshift(customer)
    persistState(this.state)
    return { lead: updatedLead, customer }
  }

  // ===== Follow =====

  async listFollows(entityType: FollowEntityType, entityId: string): Promise<Follow[]> {
    await this.delay('listFollows')
    return this.state.follows
      .filter((f) => f.entityType === entityType && f.entityId === entityId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async createFollow(input: FollowInput): Promise<Follow> {
    await this.delay('createFollow')
    const now = new Date().toISOString()
    const owner = this.state.users.find((u) => u.id === input.createdBy)
    const follow: Follow = {
      ...input,
      id: genId('f'),
      createdByName: owner?.name,
      createdAt: now,
    }
    this.state.follows.unshift(follow)
    if (input.entityType === 'customer') {
      const cIdx = this.state.customers.findIndex((c) => c.id === input.entityId)
      if (cIdx !== -1) {
        this.state.customers[cIdx] = {
          ...this.state.customers[cIdx],
          lastFollowAt: now,
          nextFollowAt: input.nextFollowAt, // 回写：带则设，不带清空（同后端）
        }
      }
    } else if (input.entityType === 'lead') {
      const lIdx = this.state.leads.findIndex((l) => l.id === input.entityId)
      if (lIdx !== -1) {
        this.state.leads[lIdx] = { ...this.state.leads[lIdx], nextFollowAt: input.nextFollowAt }
      }
    }
    persistState(this.state)
    return follow
  }

  async listFollowUps(scope: 'mine' | 'all' = 'mine'): Promise<FollowUpGroups> {
    await this.delay('listFollowUps')
    const now = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const tomorrowStart = new Date(todayStart)
    tomorrowStart.setDate(tomorrowStart.getDate() + 1)
    const weekEnd = new Date(todayStart)
    weekEnd.setDate(weekEnd.getDate() + (6 - now.getDay())) // 本周日
    weekEnd.setHours(23, 59, 59, 999)

    const ownerName = (id: string | null) =>
      id ? this.state.users.find((u) => u.id === id)?.name ?? undefined : undefined
    const latestFollow = (et: FollowEntityType, eid: string) =>
      this.state.follows
        .filter((f) => f.entityType === et && f.entityId === eid)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]

    const toItem = (
      et: FollowEntityType,
      id: string,
      name: string,
      subtitle: string | undefined,
      ownerId: string | null,
      nextFollowAt: string,
      extra: { rating?: string; status?: string; intent?: string }
    ): FollowUpItem => {
      const f = latestFollow(et, id)
      return {
        entityType: et,
        entityId: id,
        name,
        subtitle,
        ownerId,
        ownerName: ownerName(ownerId),
        nextFollowAt,
        lastFollowContent: f?.content,
        lastFollowAt: f?.createdAt,
        rating: extra.rating,
        status: extra.status,
        intent: extra.intent,
      }
    }

    const customers = applyScope(this.state.customers, scope, this.currentUserId, 'ownerId')
      .filter((c) => c.nextFollowAt)
      .map((c) =>
        toItem('customer', c.id, c.name, c.industry, c.ownerId, c.nextFollowAt!, {
          rating: c.rating,
          status: c.status,
        })
      )
    const leads = applyScope(this.state.leads, scope, this.currentUserId, 'ownerId')
      .filter((l) => l.nextFollowAt && l.status !== 'converted' && l.status !== 'discarded')
      .map((l) =>
        toItem('lead', l.id, l.name, l.company, l.ownerId, l.nextFollowAt!, {
          status: l.status,
          intent: l.intent,
        })
      )

    const overdue: FollowUpItem[] = []
    const today: FollowUpItem[] = []
    const thisWeek: FollowUpItem[] = []
    for (const item of [...customers, ...leads]) {
      const d = new Date(item.nextFollowAt)
      if (d < todayStart) overdue.push(item)
      else if (d < tomorrowStart) today.push(item)
      else if (d <= weekEnd) thisWeek.push(item)
    }
    const byNext = (a: FollowUpItem, b: FollowUpItem) => a.nextFollowAt.localeCompare(b.nextFollowAt)
    overdue.sort(byNext)
    today.sort(byNext)
    thisWeek.sort(byNext)
    return {
      overdue,
      today,
      thisWeek,
      overdueCount: overdue.length,
      totalCount: overdue.length + today.length + thisWeek.length,
    }
  }

  // ===== Contact =====

  async listContacts(customerId: string): Promise<Contact[]> {
    await this.delay('listContacts')
    return this.state.contacts
      .filter((c) => c.customerId === customerId)
      .sort((a, b) => {
        if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1
        return a.id.localeCompare(b.id)
      })
  }

  async createContact(customerId: string, input: ContactInput): Promise<Contact> {
    await this.delay('createContact')
    const now = new Date().toISOString()
    const siblings = this.state.contacts.filter((c) => c.customerId === customerId)
    const isPrimary = input.isPrimary || siblings.length === 0 // 首个自动成主
    if (isPrimary) {
      this.state.contacts = this.state.contacts.map((c) =>
        c.customerId === customerId ? { ...c, isPrimary: false } : c
      )
    }
    const contact: Contact = {
      id: genId('ct'),
      customerId,
      name: input.name,
      phone: input.phone,
      email: input.email,
      wechat: input.wechat,
      title: input.title,
      isPrimary,
      remark: input.remark,
      createdAt: now,
      updatedAt: now,
    }
    this.state.contacts.push(contact)
    persistState(this.state)
    return contact
  }

  async updateContact(id: string, input: ContactInput): Promise<Contact> {
    await this.delay('updateContact')
    const idx = this.state.contacts.findIndex((c) => c.id === id)
    if (idx === -1) throw new Error(`联系人不存在: ${id}`)
    const prev = this.state.contacts[idx]
    const updated: Contact = {
      ...prev,
      name: input.name,
      phone: input.phone,
      email: input.email,
      wechat: input.wechat,
      title: input.title,
      isPrimary: input.isPrimary ?? prev.isPrimary,
      remark: input.remark,
      updatedAt: new Date().toISOString(),
    }
    if (updated.isPrimary) {
      this.state.contacts = this.state.contacts.map((c) =>
        c.customerId === updated.customerId && c.id !== id ? { ...c, isPrimary: false } : c
      )
    }
    this.state.contacts[idx] = updated
    persistState(this.state)
    return updated
  }

  async deleteContact(id: string): Promise<void> {
    await this.delay('deleteContact')
    const target = this.state.contacts.find((c) => c.id === id)
    if (!target) throw new Error(`联系人不存在: ${id}`)
    const wasPrimary = target.isPrimary
    this.state.contacts = this.state.contacts.filter((c) => c.id !== id)
    if (wasPrimary) {
      const remaining = this.state.contacts
        .filter((c) => c.customerId === target.customerId)
        .sort((a, b) => a.id.localeCompare(b.id))
      if (remaining.length > 0) {
        const nextId = remaining[0].id
        this.state.contacts = this.state.contacts.map((c) =>
          c.id === nextId ? { ...c, isPrimary: true } : c
        )
      }
    }
    persistState(this.state)
  }

  // ===== User =====

  async listUsers(): Promise<User[]> {
    await this.delay('listUsers')
    return [...this.state.users]
  }

  async getUser(id: string): Promise<User> {
    await this.delay('getUser')
    const u = this.state.users.find((x) => x.id === id)
    if (!u) throw new Error(`用户不存在: ${id}`)
    return u
  }

  // ===== P6b 产品类目 =====

  async listCategories(): Promise<Category[]> {
    await this.delay('listCategories')
    return [...this.state.categories].sort((a, b) => a.sortOrder - b.sortOrder)
  }

  async createCategory(input: CategoryInput): Promise<Category> {
    await this.delay('createCategory')
    const name = input.name.trim()
    if (this.state.categories.some((c) => c.name === name)) {
      throw new Error(`类目「${name}」已存在`)
    }
    const cat: Category = {
      id: genId('cat'),
      name,
      sortOrder: input.sortOrder ?? this.state.categories.length,
      createdAt: new Date().toISOString(),
    }
    this.state.categories.push(cat)
    persistState(this.state)
    return cat
  }

  async updateCategory(
    id: string,
    input: Partial<CategoryInput>
  ): Promise<Category> {
    await this.delay('updateCategory')
    const idx = this.state.categories.findIndex((c) => c.id === id)
    if (idx === -1) throw new Error(`类目不存在: ${id}`)
    if (input.name !== undefined) {
      const name = input.name.trim()
      if (this.state.categories.some((c) => c.name === name && c.id !== id)) {
        throw new Error(`类目「${name}」已存在`)
      }
      this.state.categories[idx].name = name
    }
    if (input.sortOrder !== undefined) {
      this.state.categories[idx].sortOrder = input.sortOrder
    }
    persistState(this.state)
    return { ...this.state.categories[idx] }
  }

  async deleteCategory(id: string): Promise<void> {
    await this.delay('deleteCategory')
    const idx = this.state.categories.findIndex((c) => c.id === id)
    if (idx === -1) throw new Error(`类目不存在: ${id}`)
    this.state.categories.splice(idx, 1)
    this.state.customers = this.state.customers.map((c) => ({
      ...c,
      categories: c.categories.filter((x) => x.id !== id),
    }))
    persistState(this.state)
  }

  // ===== Dashboard 数据看板（P3c） =====

  async getDashboardStats(): Promise<DashboardStats> {
    await this.delay('getDashboardStats')
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    const sevenDaysAgo = new Date(now)
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)

    // 线索漏斗（各状态计数）
    const funnelOrder = ['new', 'contacting', 'qualified', 'converted', 'discarded']
    const leadFunnel: Record<string, number> = Object.fromEntries(funnelOrder.map((s) => [s, 0]))
    for (const l of this.state.leads) {
      if (leadFunnel[l.status] != null) leadFunnel[l.status] += 1
    }

    // 本月新增
    const inMonth = (iso?: string) => (iso ? new Date(iso) >= monthStart : false)
    const newCustomers = this.state.customers.filter((c) => inMonth(c.createdAt)).length
    const newLeads = this.state.leads.filter((l) => inMonth(l.createdAt)).length
    const convertedCount = this.state.leads.filter((l) => inMonth(l.convertedAt)).length

    // 跟进活跃度（最近 7 天）
    const followCount7d = this.state.follows.filter((f) => new Date(f.createdAt) >= sevenDaysAgo)
      .length

    // 每销售业绩（按负责人分组）
    const ownerName = (id: string) => this.state.users.find((u) => u.id === id)?.name
    const byOwner = new Map<string, { customerCount: number; convertedThisMonth: number }>()
    for (const c of this.state.customers) {
      if (!c.ownerId) continue
      const e = byOwner.get(c.ownerId) ?? { customerCount: 0, convertedThisMonth: 0 }
      e.customerCount += 1
      byOwner.set(c.ownerId, e)
    }
    for (const l of this.state.leads) {
      if (!l.ownerId || !inMonth(l.convertedAt)) continue
      const e = byOwner.get(l.ownerId) ?? { customerCount: 0, convertedThisMonth: 0 }
      e.convertedThisMonth += 1
      byOwner.set(l.ownerId, e)
    }
    const perOwner = [...byOwner.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([ownerId, v]) => ({
        ownerId,
        ownerName: ownerName(ownerId),
        customerCount: v.customerCount,
        convertedThisMonth: v.convertedThisMonth,
      }))

    return {
      leadFunnel,
      newThisMonth: { newCustomers, newLeads, convertedCount },
      followActivity: { followCount7d },
      perOwner,
    }
  }

  // ===== 漏斗二层复盘面板（P8，BLF-518） =====

  async getFunnelStageDetail(params: FunnelStageQuery): Promise<FunnelStageDetail> {
    await this.delay('getFunnelStageDetail')
    const { stage, sortBy = 'dwell', stuckDays = 7 } = params
    const page = params.page ?? 1
    const pageSize = params.pageSize ?? 50

    // 该阶段的线索（模拟 entered_stage_at：无字段时用 updatedAt 兜底，与后端口径一致）
    const inStage = this.state.leads.filter((l) => l.status === stage && l.id.startsWith('l-'))
    const followByLead = (leadId: string) =>
      this.state.follows
        .filter((f) => f.entityType === 'lead' && f.entityId === leadId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))

    const now = Date.now()
    const dwellOf = (l: Lead) => {
      const ref = l.updatedAt ?? l.createdAt
      return Math.max(0, Math.floor((now - new Date(ref).getTime()) / (1000 * 60 * 60 * 24)))
    }

    const rows = inStage.map((l) => {
      const last = followByLead(l.id)[0]
      const dwell = dwellOf(l)
      return {
        lead: l,
        dwell,
        lastActionAt: last?.createdAt,
        lastActionContent: last?.content,
        isStuck: dwell > stuckDays,
      }
    })

    const total = rows.length
    const sorted = [...rows].sort((a, b) =>
      sortBy === 'recent'
        ? (b.lastActionAt ?? '').localeCompare(a.lastActionAt ?? '') || a.dwell - b.dwell
        : b.dwell - a.dwell || (b.lastActionAt ?? '').localeCompare(a.lastActionAt ?? '')
    )
    const paged = sorted.slice((page - 1) * pageSize, page * pageSize)

    const ownerName = (id: string | null) =>
      id ? this.state.users.find((u) => u.id === id)?.name : undefined

    const avgDwell =
      rows.length > 0
        ? Math.round((rows.reduce((s, r) => s + r.dwell, 0) / rows.length) * 10) / 10
        : undefined

    return {
      stage,
      count: total,
      avgDwellDays: avgDwell,
      stuckCount: rows.filter((r) => r.isStuck).length,
      inflow: total,
      outflow: undefined,
      stuckDays,
      page,
      pageSize,
      total,
      leads: paged.map((r) => ({
        id: r.lead.id,
        name: r.lead.name,
        company: r.lead.company,
        ownerId: r.lead.ownerId,
        ownerName: ownerName(r.lead.ownerId),
        source: r.lead.source,
        intent: r.lead.intent,
        enteredStageAt: r.lead.updatedAt,
        lastActionAt: r.lastActionAt,
        lastActionContent: r.lastActionContent,
        nextFollowAt: r.lead.nextFollowAt,
        dwellDays: r.dwell,
        isStuck: r.isStuck,
      })),
    }
  }

  // ===== 生命周期看板（P8，BLF-520） =====

  async getLifecycleBoard(): Promise<LifecycleBoard> {
    await this.delay('getLifecycleBoard')

    const DAY = 1000 * 60 * 60 * 24
    const days = (from: string, to: string) =>
      Math.max(0, (new Date(to).getTime() - new Date(from).getTime()) / DAY)

    // first_follow：客户创建 → 第一条跟进（与后端口径一致，取最早）
    const customers = [...this.state.customers]
    const followByCustomer = (id: string) =>
      this.state.follows
        .filter((f) => f.entityType === 'customer' && f.entityId === id)
        .map((f) => f.createdAt)
        .sort()
    const firstFollowDays: number[] = []
    for (const c of customers) {
      const first = followByCustomer(c.id)[0]
      if (first) firstFollowDays.push(days(c.createdAt, first))
    }

    // conversion：线索创建 → converted_at
    const leads = [...this.state.leads]
    const conversionDays: number[] = []
    for (const l of leads) {
      if (l.convertedAt) conversionDays.push(days(l.createdAt, l.convertedAt))
    }

    // churn：公海客户 mock 合成回公海事件（创建后 (id 哈希 % 45) 天），
    // 演示用——mock 无审计日志，用确定性假事件铺出分布形状。
    const churnDays: number[] = []
    for (const c of customers) {
      if (c.ownerId) continue
      const hash = [...c.id].reduce((s, ch) => s + ch.charCodeAt(0), 0)
      churnDays.push(Math.max(1, hash % 45))
    }

    const bucketize = (durations: number[]) => {
      const edges = [1, 3, 7, 14, 30]
      const labels = ['1 天内', '1-3 天', '3-7 天', '7-14 天', '14-30 天', '30 天以上']
      const counts = labels.map(() => 0)
      for (const d of durations) {
        const i = edges.findIndex((e) => d < e)
        counts[i === -1 ? labels.length - 1 : i] += 1
      }
      const n = Math.max(durations.length, 1)
      let cumulative = 0
      return labels.map((label, i) => {
        cumulative += counts[i]
        return {
          label,
          minDays: i === 0 ? 0 : edges[i - 1],
          maxDays: i === labels.length - 1 ? undefined : edges[i],
          count: counts[i],
          pct: Math.round((counts[i] / n) * 10000) / 10000,
          cumulativePct: Math.round((cumulative / n) * 10000) / 10000,
        }
      })
    }

    const summary = (durations: number[]) => {
      const ordered = [...durations].sort((a, b) => a - b)
      const n = ordered.length
      if (n === 0) return { sampleCount: 0, avgDays: undefined, medianDays: undefined, p90Days: undefined, maxDays: undefined }
      const mid = Math.floor(n / 2)
      const median = n % 2 ? ordered[mid] : (ordered[mid - 1] + ordered[mid]) / 2
      const round1 = (v: number) => Math.round(v * 10) / 10
      return {
        sampleCount: n,
        avgDays: round1(ordered.reduce((s, d) => s + d, 0) / n),
        medianDays: round1(median),
        p90Days: round1(ordered[Math.min(n - 1, Math.floor(n * 0.9))]),
        maxDays: round1(ordered[n - 1]),
      }
    }

    const dist = (
      metric: LifecycleBoard['firstFollow']['metric'],
      label: string,
      description: string,
      durations: number[],
      totalCount: number
    ): LifecycleDistribution => ({
      metric,
      label,
      description,
      buckets: bucketize(durations),
      summary: { ...summary(durations), totalCount },
    })

    return {
      firstFollow: dist(
        'first_follow',
        '首次跟进',
        '客户创建 → 第一条跟进记录',
        firstFollowDays,
        customers.length
      ),
      conversion: dist(
        'conversion',
        '转化',
        '线索创建 → 转化完成（线索转客户）',
        conversionDays,
        leads.length
      ),
      churn: dist('churn', '流失', '客户创建 → 首次回公海', churnDays, customers.length),
      nowInSea: customers.filter((c) => !c.ownerId).length,
    }
  }

  // ===== Audit Log 操作审计日志（P4） =====

  async listAuditLogs(params: AuditLogQuery): Promise<Paginated<AuditLog>> {
    await this.delay('listAuditLogs')
    const all = this.state.audits ?? []
    // P5-9: 多值过滤（entityTypes / entityIds）优先于单值（entityType / entityId）。
    const typeSet = params.entityTypes && params.entityTypes.length > 0 ? new Set(params.entityTypes) : null
    const idSet = params.entityIds && params.entityIds.length > 0 ? new Set(params.entityIds.map(String)) : null
    const filtered = all.filter(
      (a) =>
        (!typeSet || typeSet.has(a.entityType)) &&
        (!idSet || idSet.has(a.entityId)) &&
        (!params.entityType || a.entityType === params.entityType) &&
        (!params.entityId || a.entityId === params.entityId) &&
        (!params.action || a.action === params.action)
    )
    const page = params.page ?? 1
    const pageSize = params.pageSize ?? 20
    return {
      items: filtered.slice((page - 1) * pageSize, page * pageSize),
      total: filtered.length,
      page,
      pageSize,
    }
  }

  // ===== Task（P7，BLF-512） =====

  async listTasks(params: TaskListParams): Promise<Paginated<Task>> {
    await this.delay('listTasks')
    let items = this.state.tasks
    if (params.type) items = items.filter((t) => t.type === params.type)
    if (params.status) items = items.filter((t) => t.status === params.status)
    if (params.priority) items = items.filter((t) => t.priority === params.priority)
    if (params.ownerId) items = items.filter((t) => t.ownerId === params.ownerId)
    if (params.customerId) items = items.filter((t) => t.customerId === params.customerId)
    if (params.leadId) items = items.filter((t) => t.leadId === params.leadId)
    items = applyScope(items, params.scope, this.currentUserId, 'ownerId')
    // 默认按截止时间升序、无截止排最后（与后端 list_tasks 一致）
    const sorted = [...items].sort((a, b) => {
      const da = a.dueDate ? new Date(a.dueDate).getTime() : Number.POSITIVE_INFINITY
      const db = b.dueDate ? new Date(b.dueDate).getTime() : Number.POSITIVE_INFINITY
      if (da !== db) return params.sortOrder === 'desc' ? db - da : da - db
      return a.id.localeCompare(b.id)
    })
    return paginate(sorted, params.page, params.pageSize)
  }

  async setTaskStatus(id: string, status: TaskStatus): Promise<Task> {
    await this.delay('setTaskStatus')
    const idx = this.state.tasks.findIndex((t) => t.id === id)
    if (idx === -1) throw new Error(`任务不存在: ${id}`)
    const prev = this.state.tasks[idx]
    const updated: Task = {
      ...prev,
      status,
      completedAt:
        status === 'done' ? (prev.completedAt ?? new Date().toISOString()) : undefined,
      updatedAt: new Date().toISOString(),
    }
    this.state.tasks[idx] = updated
    persistState(this.state)
    return updated
  }

  // ===== Task 创建/编辑/完成/取消（P7，BLF-514） =====

  async createTask(input: TaskInput): Promise<Task> {
    await this.delay('createTask')
    const now = new Date().toISOString()
    const id = genId('t')
    const owner = input.ownerId
      ? this.state.users.find((u) => u.id === input.ownerId)
      : null
    const customer = input.customerId
      ? this.state.customers.find((c) => c.id === input.customerId)
      : null
    const lead = input.leadId ? this.state.leads.find((l) => l.id === input.leadId) : null
    const task: Task = {
      ...input,
      id,
      status: 'pending',
      ownerId: input.ownerId ?? this.currentUserId,
      ownerName: input.ownerId ? owner?.name : undefined,
      customerId: input.customerId ?? undefined,
      customerName: customer?.name,
      leadId: input.leadId ?? undefined,
      leadName: lead?.name,
      createdAt: now,
      updatedAt: now,
    }
    this.state.tasks.unshift(task)
    persistState(this.state)
    return task
  }

  async updateTask(id: string, input: Partial<TaskInput>): Promise<Task> {
    await this.delay('updateTask')
    const idx = this.state.tasks.findIndex((t) => t.id === id)
    if (idx === -1) throw new Error(`任务不存在: ${id}`)
    const prev = this.state.tasks[idx]
    const owner =
      input.ownerId !== undefined
        ? (this.state.users.find((u) => u.id === input.ownerId) ?? null)
        : null
    const customer =
      input.customerId !== undefined
        ? (this.state.customers.find((c) => c.id === input.customerId) ?? null)
        : null
    const lead =
      input.leadId !== undefined
        ? (this.state.leads.find((l) => l.id === input.leadId) ?? null)
        : null
    const updated: Task = {
      ...prev,
      ...input,
      ownerName: input.ownerId !== undefined ? owner?.name : prev.ownerName,
      customerName: input.customerId !== undefined ? customer?.name : prev.customerName,
      leadName: input.leadId !== undefined ? lead?.name : prev.leadName,
      updatedAt: new Date().toISOString(),
    }
    this.state.tasks[idx] = updated
    persistState(this.state)
    return updated
  }

  async completeTask(id: string): Promise<Task> {
    await this.delay('completeTask')
    const idx = this.state.tasks.findIndex((t) => t.id === id)
    if (idx === -1) throw new Error(`任务不存在: ${id}`)
    const prev = this.state.tasks[idx]
    const updated: Task = {
      ...prev,
      status: 'done',
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    this.state.tasks[idx] = updated
    persistState(this.state)
    return updated
  }

  async cancelTask(id: string): Promise<Task> {
    await this.delay('cancelTask')
    const idx = this.state.tasks.findIndex((t) => t.id === id)
    if (idx === -1) throw new Error(`任务不存在: ${id}`)
    const prev = this.state.tasks[idx]
    const updated: Task = {
      ...prev,
      status: 'cancelled',
      completedAt: undefined,
      updatedAt: new Date().toISOString(),
    }
    this.state.tasks[idx] = updated
    persistState(this.state)
    return updated
  }

  // ===== 规则引擎（P9，BLF-543/545） =====

  async listRules(): Promise<Rule[]> {
    await this.delay('listRules')
    // 深拷贝（conditions/actions 嵌套对象，避免调用方误改 mock 状态）
    return this.state.rules.map((r) => structuredClone(r))
  }

  async createRule(input: RuleInput): Promise<Rule> {
    await this.delay('createRule')
    const now = new Date().toISOString()
    const id = this.state.rules.reduce((max, r) => Math.max(max, r.id), 0) + 1
    const rule: Rule = {
      ...input,
      id,
      priority: input.priority ?? 0,
      conditions: (input.conditions ?? []).map((c, i) => ({ ...c, sortOrder: i })),
      actions: (input.actions ?? []).map((a, i) => ({ ...a, sortOrder: i })),
      createdAt: now,
      updatedAt: now,
    }
    this.state.rules.unshift(rule)
    persistState(this.state)
    return structuredClone(rule)
  }

  async updateRule(id: number, input: Partial<RuleInput>): Promise<Rule> {
    await this.delay('updateRule')
    const idx = this.state.rules.findIndex((r) => r.id === id)
    if (idx === -1) throw new Error(`规则不存在: ${id}`)
    const prev = this.state.rules[idx]
    const updated: Rule = {
      ...prev,
      ...input,
      conditions: input.conditions?.map((c, i) => ({ ...c, sortOrder: i })) ?? prev.conditions,
      actions: input.actions?.map((a, i) => ({ ...a, sortOrder: i })) ?? prev.actions,
      updatedAt: new Date().toISOString(),
    }
    this.state.rules[idx] = updated
    persistState(this.state)
    return structuredClone(updated)
  }

  async deleteRule(id: number): Promise<void> {
    await this.delay('deleteRule')
    const idx = this.state.rules.findIndex((r) => r.id === id)
    if (idx === -1) throw new Error(`规则不存在: ${id}`)
    this.state.rules.splice(idx, 1)
    persistState(this.state)
  }

  // ===== P9 工作流自动化设置（BLF-540） =====
  async getWorkflowSettings(): Promise<WorkflowSettings> {
    await this.delay('getWorkflowSettings')
    return { ...this.state.workflowSettings }
  }

  async updateWorkflowSettings(input: Partial<WorkflowSettings>): Promise<WorkflowSettings> {
    await this.delay('updateWorkflowSettings')
    const next: WorkflowSettings = {
      ...this.state.workflowSettings,
      staleDays: input.staleDays ?? this.state.workflowSettings.staleDays,
      staleEmailEnabled:
        input.staleEmailEnabled ?? this.state.workflowSettings.staleEmailEnabled,
    }
    this.state.workflowSettings = next
    persistState(this.state)
    return { ...next }
  }

  // ===== 客户方案（Proposal）=====

  private proposalVersionsOf(proposalId: string): ProposalVersion[] {
    return this.state.proposalVersions
      .filter((v) => v.id.startsWith(`pv-${proposalId}-`))
      .sort((a, b) => b.versionNo - a.versionNo)
  }

  private bodyKey(proposalId: string, versionNo: number): string {
    return `${proposalId}:${versionNo}`
  }

  private readBody(proposalId: string, versionNo: number): string {
    const key = this.bodyKey(proposalId, versionNo)
    if (this.state.proposalBodies[key]) return this.state.proposalBodies[key]
    const proposal = this.state.proposals.find((p) => p.id === proposalId)
    return mockProposalHtml(proposal?.title ?? '方案', versionNo)
  }

  async listProposals(params: ProposalListParams): Promise<Paginated<Proposal>> {
    await this.delay('listProposals')
    let items = applyScope(this.state.proposals, params.scope ?? 'mine', this.currentUserId, 'ownerId')
    items = applyKeyword(items, params.keyword, ['title', 'customerName'])
    items = applyFilters(items, params.filters)
    items = applySort(items, params.sortBy ?? 'updatedAt', params.sortOrder ?? 'desc')
    return paginate(items, params.page, params.pageSize)
  }

  async getProposal(id: string): Promise<ProposalDetail> {
    await this.delay('getProposal')
    const proposal = this.state.proposals.find((p) => p.id === id)
    if (!proposal) throw new Error(`方案不存在: ${id}`)
    return { ...proposal, versions: this.proposalVersionsOf(id) }
  }

  async createProposal(input: ProposalCreateInput): Promise<ProposalUploadResult> {
    await this.delay('createProposal')
    const id = genId('p')
    const content = await input.file.text()
    const customer = this.state.customers.find((c) => c.id === input.customerId)
    const proposal: Proposal = {
      id,
      title: input.title?.trim() || input.file.name.replace(/\.html?$/i, '') || '未命名方案',
      proposalType: input.proposalType ?? 'other',
      status: 'draft',
      customerId: input.customerId ?? undefined,
      customerName: customer?.name,
      ownerId: this.currentUserId,
      ownerName: this.state.users.find((u) => u.id === this.currentUserId)?.name,
      currentVersionNo: 1,
      versionCount: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    const version: ProposalVersion = {
      id: `pv-${id}-1`,
      versionNo: 1,
      originalFilename: input.file.name,
      contentType: input.file.type || 'text/html',
      fileSize: input.file.size,
      changeNote: '初始版本',
      createdBy: this.currentUserId,
      createdAt: proposal.createdAt,
    }
    this.state.proposals = [proposal, ...this.state.proposals]
    this.state.proposalVersions = [version, ...this.state.proposalVersions]
    this.state.proposalBodies[this.bodyKey(id, 1)] = content
    persistState(this.state)
    return { proposal, version, warnings: [] }
  }

  async addProposalVersion(
    id: string,
    input: ProposalVersionInput
  ): Promise<ProposalUploadResult> {
    await this.delay('addProposalVersion')
    const proposal = this.state.proposals.find((p) => p.id === id)
    if (!proposal) throw new Error(`方案不存在: ${id}`)
    const versionNo = proposal.currentVersionNo + 1
    const content = await input.file.text()
    const version: ProposalVersion = {
      id: `pv-${id}-${versionNo}`,
      versionNo,
      originalFilename: input.file.name,
      contentType: input.file.type || 'text/html',
      fileSize: input.file.size,
      changeNote: input.changeNote,
      createdBy: this.currentUserId,
      createdAt: new Date().toISOString(),
    }
    const next: Proposal = {
      ...proposal,
      currentVersionNo: versionNo,
      versionCount: proposal.versionCount + 1,
      updatedAt: version.createdAt,
    }
    this.state.proposals = this.state.proposals.map((p) => (p.id === id ? next : p))
    this.state.proposalVersions = [version, ...this.state.proposalVersions]
    this.state.proposalBodies[this.bodyKey(id, versionNo)] = content
    persistState(this.state)
    return { proposal: next, version, warnings: [] }
  }

  async updateProposal(
    id: string,
    input: Partial<ProposalUpdateInput>
  ): Promise<Proposal> {
    await this.delay('updateProposal')
    const proposal = this.state.proposals.find((p) => p.id === id)
    if (!proposal) throw new Error(`方案不存在: ${id}`)
    const customer =
      input.customerId != null
        ? this.state.customers.find((c) => c.id === input.customerId)
        : undefined
    const next: Proposal = {
      ...proposal,
      title: input.title ?? proposal.title,
      proposalType: input.proposalType ?? proposal.proposalType,
      status: input.status ?? proposal.status,
      customerId: input.customerId === undefined ? proposal.customerId : input.customerId ?? undefined,
      customerName: input.customerId === undefined ? proposal.customerName : customer?.name,
      updatedAt: new Date().toISOString(),
    }
    this.state.proposals = this.state.proposals.map((p) => (p.id === id ? next : p))
    persistState(this.state)
    return next
  }

  async deleteProposal(id: string): Promise<void> {
    await this.delay('deleteProposal')
    this.state.proposals = this.state.proposals.filter((p) => p.id !== id)
    this.state.proposalVersions = this.state.proposalVersions.filter(
      (v) => !v.id.startsWith(`pv-${id}-`)
    )
    for (const key of Object.keys(this.state.proposalBodies)) {
      if (key.startsWith(`${id}:`)) delete this.state.proposalBodies[key]
    }
    persistState(this.state)
  }

  async getProposalVersionContent(
    id: string,
    versionNo: number
  ): Promise<ProposalContent> {
    await this.delay('getProposalVersionContent')
    const proposal = this.state.proposals.find((p) => p.id === id)
    if (!proposal) throw new Error(`方案不存在: ${id}`)
    return {
      proposalId: id,
      versionNo,
      title: proposal.title,
      content: this.readBody(id, versionNo),
    }
  }

  async downloadProposalVersion(id: string, versionNo: number): Promise<Blob> {
    await this.delay('downloadProposalVersion')
    return new Blob([this.readBody(id, versionNo)], { type: 'text/html;charset=utf-8' })
  }
}
