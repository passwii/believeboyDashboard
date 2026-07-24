import type { CrmClient, FilterCondition, ListParams, Paginated } from './crm-client'
import type {
  Contact,
  ContactInput,
  Customer,
  CustomerInput,
  DashboardStats,
  Follow,
  FollowEntityType,
  FollowInput,
  FollowUpGroups,
  FollowUpItem,
  Lead,
  LeadInput,
  User,
} from '@/lib/crm/types'
import {
  CUSTOMERS_FIXTURE,
  LEADS_FIXTURE,
  FOLLOWS_FIXTURE,
  USERS_FIXTURE,
} from './mock-data'

const STORAGE_KEY = 'believeboy-crm-mock-state-v1'
const LATENCY_MIN = 150
const LATENCY_MAX = 400
const E2E_LATENCY_MS = 200
const ERROR_RATE = 0.05

interface MockState {
  customers: Customer[]
  leads: Lead[]
  follows: Follow[]
  contacts: Contact[]
  users: User[]
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
      }
    }
    const parsed = JSON.parse(raw) as Partial<MockState>
    return {
      customers: parsed.customers ?? [...CUSTOMERS_FIXTURE],
      leads: parsed.leads ?? [...LEADS_FIXTURE],
      follows: parsed.follows ?? [...FOLLOWS_FIXTURE],
      contacts: parsed.contacts ?? [],
      users: parsed.users ?? [...USERS_FIXTURE],
    }
  } catch {
    return {
      customers: [...CUSTOMERS_FIXTURE],
      leads: [...LEADS_FIXTURE],
      follows: [...FOLLOWS_FIXTURE],
      contacts: [],
      users: [...USERS_FIXTURE],
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
      createdAt: now,
      updatedAt: now,
      createdBy: this.currentUserId,
    }
    this.state.customers.unshift(customer)
    persistState(this.state)
    return customer
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
}
