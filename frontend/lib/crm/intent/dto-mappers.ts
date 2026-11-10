/**
 * crm_intent 用户端 API 的 DTO → 领域模型映射。
 *
 * 契约来源：docs/superpowers/specs/2026-11-10-crm-intent-workbench-design.md §5。
 * FastAPI OpenAPI 不含 Go-only 端点，因此 DTO 手写、不跑 gen:api-types；
 * 映射对可选字段做防御性兜底（缺字段不抛错，展示「—」/ 空数组）。
 */
import {
  INTENT_LEVEL_LABELS,
  INTENT_LEVEL_ORDER,
  INTENT_POOL_STATUS_LABELS,
  INTENT_STATE_LABELS,
  INTENT_STATE_ORDER,
  type IntentBoard,
  type IntentBoardGroup,
  type IntentBoardItem,
  type IntentBatch,
  type IntentBatchDetail,
  type IntentBatchPage,
  type IntentBatchSummary,
  type IntentCityFacet,
  type IntentCompany,
  type IntentCompanyDetail,
  type IntentCompanyPage,
  type IntentConvertResult,
  type IntentFacets,
  type IntentFollowup,
  type IntentImportResult,
  type IntentImportRow,
  type IntentLevel,
  type IntentMeta,
  type IntentOwner,
  type IntentPhone,
  type IntentPhoneSource,
  type IntentPoolItem,
  type IntentPoolPage,
  type IntentPoolStatus,
  type IntentSharedPhoneGroup,
  type IntentState,
  type IntentStateFacet,
  type IntentStats,
} from './types'

// ===== 手写 DTO（snake_case，Go 用户端响应） =====

export interface IntentPhoneDto {
  id?: number
  phone_raw?: string
  phone_normalized?: string
  raw?: string
  source?: string
  is_valid?: boolean
  created_by?: string | null
}

export interface IntentFollowupDto {
  company_id?: number
  state?: string
  state_label?: string
  note?: string
  last_contact_at?: string | null
  next_contact_at?: string | null
  version?: number
  updated_by?: string | null
  updated_at?: string | null
}

export interface IntentOwnerDto {
  id?: string
  name?: string
}

export interface IntentCompanyDto {
  id?: number
  batch_id?: number | null
  batch_date?: string | null
  batch?: { id?: number; batch_date?: string | null } | null
  external_id?: string | null
  name?: string
  credit_code?: string | null
  legal_person?: string | null
  province?: string | null
  city?: string | null
  founded_year?: number | null
  registered_capital_wan?: number | string | null
  products?: string | null
  category?: string | null
  channel?: string | null
  channels?: unknown
  trademarks?: unknown
  trademark_count?: number | null
  intent_level?: string | null
  intent_level_label?: string | null
  intent_score?: number | null
  intent_basis?: string | null
  amazon_fit?: string | null
  walmart_fit?: string | null
  sources?: unknown
  risks?: string | null
  screened_at?: string | null
  phone_note?: string | null
  owner?: IntentOwnerDto | null
  owner_id?: string | null
  owner_name?: string | null
  human_touched?: boolean | null
  converted_customer_id?: number | null
  converted_at?: string | null
  phones?: unknown
  followup?: IntentFollowupDto | null
}

export interface IntentCompanyPageDto {
  items?: unknown
  total?: number
  page?: number
  page_size?: number
}

export interface IntentMetaDto {
  batch?: Record<string, unknown> | null
  batch_date?: string | null
  stats?: Record<string, unknown> | null
  facets?: Record<string, unknown> | null
  data_rev?: number
  followup_rev?: number
  changed?: boolean
  server_time?: string | null
}

export interface IntentPoolItemDto {
  id?: number
  name?: string
  legal_person?: string | null
  website?: string | null
  channel?: string | null
  channels?: unknown
  channel_source?: string | null
  status?: string
  phones?: unknown
}

export interface IntentBoardDto {
  groups?: unknown
  board?: unknown
  total?: number
}

export interface IntentImportResultDto {
  batch_id?: number | null
  total_companies?: number
  total_pool?: number
  companies_total?: number
  created?: number
  updated?: number
  skipped_locked?: number
  skipped_existing?: number
  created_count?: number
  updated_count?: number
  skipped_locked_count?: number
  rejected_count?: number
  data_rev?: number
  status?: string
  error_detail?: string | null
  rows?: unknown
  rejected?: unknown
  rows_truncated?: boolean
  result?: Record<string, unknown> | null
}

/** BE Batch / BatchDetail DTO（GET /batches、GET /batches/{id}）。 */
export interface IntentBatchDto {
  id?: number
  batch_date?: string
  source?: string
  source_label?: string
  source_file_name?: string | null
  total_companies?: number
  total_pool?: number
  created_count?: number
  updated_count?: number
  skipped_locked_count?: number
  rejected_count?: number
  status?: string
  error_detail?: string | null
  created_at?: string | null
  completed_at?: string | null
  rejected?: unknown
  rows?: unknown
  rows_truncated?: boolean
}

// ===== 基础读取工具 =====

type Rec = Record<string, unknown>

function rec(value: unknown): Rec | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Rec)
    : null
}

function recList(value: unknown): Rec[] {
  return Array.isArray(value) ? value.map(rec).filter((item): item is Rec => item !== null) : []
}

export function asString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

export function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export function asInt(value: unknown, fallback = 0): number {
  const parsed = asNumber(value)
  return parsed === null ? fallback : Math.trunc(parsed)
}

export function asBool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase()
    if (lowered === 'true' || lowered === '1') return true
    if (lowered === 'false' || lowered === '0') return false
  }
  return null
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map(asString).filter((item): item is string => item !== null)
}

// ===== 枚举归一 =====

export function normalizeIntentLevel(value: unknown): IntentLevel {
  const text = asString(value)
  return text === 'A' || text === 'B' || text === 'C' || text === 'D' ? text : 'D'
}

export function normalizeIntentState(value: unknown): IntentState {
  const text = asString(value)
  return (INTENT_STATE_ORDER as readonly string[]).includes(text ?? '')
    ? (text as IntentState)
    : 'none'
}

function normalizePoolStatus(value: unknown): IntentPoolStatus {
  const text = asString(value)
  return text === 'screened' || text === 'ignored' || text === 'pending' ? text : 'pending'
}

function normalizePhoneSource(value: unknown): IntentPhoneSource {
  const text = asString(value)
  return text === 'manual' || text === 'ai' || text === 'list' ? text : 'list'
}

// ===== 实体映射 =====

export function mapIntentPhone(value: unknown): IntentPhone {
  const dto = rec(value) ?? {}
  const raw = asString(dto.phone_raw) ?? asString(dto.raw) ?? ''
  const normalized = asString(dto.phone_normalized) ?? raw
  return {
    id: asInt(dto.id, 0),
    raw,
    normalized,
    source: normalizePhoneSource(dto.source),
    isValid: asBool(dto.is_valid) ?? false,
    createdBy: asString(dto.created_by),
  }
}

export function mapIntentPhoneList(value: unknown): IntentPhone[] {
  return recList(value).map(mapIntentPhone)
}

export const EMPTY_INTENT_FOLLOWUP: IntentFollowup = {
  state: 'none',
  stateLabel: INTENT_STATE_LABELS.none,
  note: '',
  lastContactAt: null,
  nextContactAt: null,
  version: 0,
  updatedAt: null,
  updatedBy: null,
}

export function mapIntentFollowup(value: unknown): IntentFollowup {
  const dto = rec(value) ?? {}
  const state = normalizeIntentState(dto.state)
  return {
    state,
    stateLabel: asString(dto.state_label) ?? INTENT_STATE_LABELS[state],
    note: asString(dto.note) ?? '',
    lastContactAt: asString(dto.last_contact_at),
    nextContactAt: asString(dto.next_contact_at),
    version: asInt(dto.version, 0),
    updatedAt: asString(dto.updated_at),
    updatedBy: asString(dto.updated_by),
  }
}

/** PATCH followup 响应：兼容 {…followup 字段} 与 {followup:{…}} 两种形状。 */
export function mapIntentFollowupResponse(value: unknown): IntentFollowup {
  const dto = rec(value)
  if (!dto) return { ...EMPTY_INTENT_FOLLOWUP }
  const nested = rec(dto.followup)
  return mapIntentFollowup(nested ?? dto)
}

export function mapIntentOwner(value: unknown): IntentOwner | null {
  const dto = rec(value)
  if (!dto) return null
  const nested = rec(dto.owner) ?? dto
  const id = asString(nested.id) ?? asString(dto.owner_id)
  const name = asString(nested.name) ?? asString(dto.owner_name)
  if (!id && !name) return null
  return { id: id ?? '', name: name ?? '' }
}

function mapIntentCompanyCore(value: unknown): IntentCompany {
  const dto = rec(value) ?? {}
  const batch = rec(dto.batch)
  const level = normalizeIntentLevel(dto.intent_level)
  const rawChannels = asStringList(dto.channels)
  const singleChannel = asString(dto.channel)
  const channels = rawChannels.length > 0 ? rawChannels : singleChannel ? [singleChannel] : []
  const phones = mapIntentPhoneList(dto.phones)
  const followup = dto.followup ? mapIntentFollowup(dto.followup) : { ...EMPTY_INTENT_FOLLOWUP }
  const owner = mapIntentOwner(dto.owner) ?? mapIntentOwner(dto)
  return {
    id: asInt(dto.id, 0),
    batchId: asNumber(dto.batch_id) !== null ? asInt(dto.batch_id) : batch ? asInt(batch.id, 0) || null : null,
    batchDate: asString(dto.batch_date) ?? (batch ? asString(batch.batch_date) : null),
    externalId: asString(dto.external_id),
    name: asString(dto.name) ?? '（未命名企业）',
    creditCode: asString(dto.credit_code),
    legalPerson: asString(dto.legal_person),
    province: asString(dto.province),
    city: asString(dto.city),
    foundedYear: asNumber(dto.founded_year) === null ? null : asInt(dto.founded_year),
    registeredCapitalWan: asNumber(dto.registered_capital_wan),
    products: asString(dto.products),
    category: asString(dto.category),
    channels,
    trademarks: asStringList(dto.trademarks),
    trademarkCount: asInt(dto.trademark_count, asStringList(dto.trademarks).length),
    intentLevel: level,
    intentScore: asNumber(dto.intent_score),
    intentBasis: asString(dto.intent_basis),
    amazonFit: asString(dto.amazon_fit),
    walmartFit: asString(dto.walmart_fit),
    sources: asStringList(dto.sources),
    risks: asString(dto.risks),
    screenedAt: asString(dto.screened_at),
    phoneNote: asString(dto.phone_note),
    owner,
    humanTouched: asBool(dto.human_touched) ?? false,
    convertedCustomerId: asNumber(dto.converted_customer_id) === null ? null : asInt(dto.converted_customer_id),
    convertedAt: asString(dto.converted_at),
    phones,
    followup,
  }
}

export function mapIntentCompany(value: unknown): IntentCompany {
  return mapIntentCompanyCore(value)
}

export function mapIntentSharedPhones(value: unknown): IntentSharedPhoneGroup[] {
  return recList(value).map((dto) => ({
    phoneNormalized: asString(dto.phone_normalized) ?? '',
    raw: asString(dto.raw) ?? asString(dto.phone_normalized) ?? '',
    companies: recList(dto.companies).map((company) => ({
      id: asInt(company.id, 0),
      name: asString(company.name) ?? '（未命名企业）',
      intentLevel: normalizeIntentLevel(company.intent_level),
    })),
    pool: recList(dto.pool).map((poolItem) => ({
      id: asInt(poolItem.id, 0),
      name: asString(poolItem.name) ?? '（未命名企业）',
      status: normalizePoolStatus(poolItem.status),
    })),
  }))
}

export function mapIntentCompanyDetail(value: unknown): IntentCompanyDetail {
  const dto = rec(value) ?? {}
  return {
    ...mapIntentCompanyCore(value),
    sharedPhones: mapIntentSharedPhones(dto.shared_phones),
  }
}

export function mapIntentCompanyPage(value: unknown): IntentCompanyPage {
  if (Array.isArray(value)) {
    return { items: value.map(mapIntentCompany), total: value.length, page: 1, pageSize: value.length }
  }
  const dto = rec(value) ?? {}
  const items = Array.isArray(dto.items) ? dto.items.map(mapIntentCompany) : []
  return {
    items,
    total: asInt(dto.total, items.length),
    page: asInt(dto.page, 1),
    pageSize: asInt(dto.page_size ?? dto.pageSize, items.length),
  }
}

export function mapIntentStats(value: unknown): IntentStats {
  const dto = rec(value) ?? {}
  const rawLevels = rec(dto.by_level ?? dto.byLevel) ?? {}
  const byLevel = INTENT_LEVEL_ORDER.reduce(
    (acc, level) => {
      acc[level] = asInt(rawLevels[level])
      return acc
    },
    { A: 0, B: 0, C: 0, D: 0 } as Record<IntentLevel, number>
  )
  return {
    total: asInt(dto.total),
    byLevel,
    withPhone: asInt(dto.with_phone ?? dto.withPhone),
    contacted: asInt(dto.contacted),
    followedUp: asInt(dto.followed_up ?? dto.followedUp),
    poolTotal: asInt(dto.pool_total ?? dto.poolTotal),
    dupGroups: asInt(dto.dup_groups ?? dto.dupGroups),
    dueCount: asInt(dto.due_count ?? dto.dueCount),
  }
}

function mapCityFacets(value: unknown): IntentCityFacet[] {
  return recList(value)
    .map((entry) => ({
      province: asString(entry.province) ?? '',
      cities: asStringList(entry.cities),
    }))
    .filter((entry) => entry.province.length > 0)
}

function mapStateFacets(value: unknown): IntentStateFacet[] {
  const entries = Array.isArray(value) ? value : []
  const mapped = entries
    .map((entry): IntentStateFacet | null => {
      if (typeof entry === 'string') {
        const state = normalizeIntentState(entry)
        return { value: state, label: INTENT_STATE_LABELS[state] }
      }
      const dto = rec(entry)
      if (!dto) return null
      const rawValue = asString(dto.value) ?? asString(dto.code) ?? asString(dto.state)
      if (!rawValue) return null
      const state = normalizeIntentState(rawValue)
      return { value: state, label: asString(dto.label) ?? INTENT_STATE_LABELS[state] }
    })
    .filter((entry): entry is IntentStateFacet => entry !== null)
  if (mapped.length > 0) return mapped
  return INTENT_STATE_ORDER.map((state) => ({ value: state, label: INTENT_STATE_LABELS[state] }))
}

export function mapIntentFacets(value: unknown): IntentFacets {
  const dto = rec(value) ?? {}
  const rawLevels = Array.isArray(dto.levels) ? dto.levels.map(normalizeIntentLevel) : []
  const levels = rawLevels.length > 0 ? dedupeLevels(rawLevels) : [...INTENT_LEVEL_ORDER]
  return {
    levels,
    categories: asStringList(dto.categories),
    channels: asStringList(dto.channels),
    provinces: asStringList(dto.provinces),
    cities: mapCityFacets(dto.cities),
    states: mapStateFacets(dto.states),
  }
}

function dedupeLevels(levels: IntentLevel[]): IntentLevel[] {
  return INTENT_LEVEL_ORDER.filter((level) => levels.includes(level))
}

export function mapIntentMeta(value: unknown): IntentMeta {
  const dto = rec(value) ?? {}
  const stats = mapIntentStats(dto.stats)
  const facets = mapIntentFacets(dto.facets)
  const batchDto = rec(dto.batch)
  const batch: IntentBatch | null = batchDto
    ? {
        id: asNumber(batchDto.id) === null ? null : asInt(batchDto.id),
        batchDate: asString(batchDto.batch_date),
        updatedAt: asString(batchDto.updated_at),
        total: asInt(batchDto.total, stats.total),
        poolTotal: asInt(batchDto.pool_total, stats.poolTotal),
        source: asString(batchDto.source),
        sourceFileName: asString(batchDto.source_file_name),
      }
    : asString(dto.batch_date)
      ? {
          id: null,
          batchDate: asString(dto.batch_date),
          updatedAt: null,
          total: stats.total,
          poolTotal: stats.poolTotal,
          source: null,
          sourceFileName: null,
        }
      : null
  return {
    batch,
    stats,
    facets,
    dataRev: asInt(dto.data_rev ?? dto.dataRev),
    followupRev: asInt(dto.followup_rev ?? dto.followupRev),
    changed: asBool(dto.changed) ?? true,
    serverTime: asString(dto.server_time ?? dto.serverTime),
  }
}

export function mapIntentPoolItem(value: unknown): IntentPoolItem {
  const dto = rec(value) ?? {}
  const channels = asStringList(dto.channels)
  const singleChannel = asString(dto.channel)
  const merged = channels.length > 0 ? channels : singleChannel ? [singleChannel] : []
  return {
    id: asInt(dto.id, 0),
    name: asString(dto.name) ?? '（未命名企业）',
    legalPerson: asString(dto.legal_person),
    website: asString(dto.website),
    channel: singleChannel,
    channels: merged,
    channelSource: asString(dto.channel_source),
    status: normalizePoolStatus(dto.status),
    phones: mapIntentPhoneList(dto.phones),
  }
}

export function mapIntentPoolPage(value: unknown): IntentPoolPage {
  if (Array.isArray(value)) {
    return { items: value.map(mapIntentPoolItem), total: value.length, page: 1, pageSize: value.length }
  }
  const dto = rec(value) ?? {}
  const items = Array.isArray(dto.items) ? dto.items.map(mapIntentPoolItem) : []
  return {
    items,
    total: asInt(dto.total, items.length),
    page: asInt(dto.page, 1),
    pageSize: asInt(dto.page_size ?? dto.pageSize, items.length),
  }
}

function mapIntentBoardItem(value: unknown): IntentBoardItem {
  const dto = rec(value) ?? {}
  const level = normalizeIntentLevel(dto.intent_level)
  return {
    id: asInt(dto.id, 0),
    name: asString(dto.name) ?? '（未命名企业）',
    intentLevel: level,
    intentLevelLabel: asString(dto.intent_level_label) ?? INTENT_LEVEL_LABELS[level],
    intentScore: asNumber(dto.intent_score),
    nextContactAt: asString(dto.next_contact_at),
    owner: mapIntentOwner(dto.owner),
    updatedAt: asString(dto.updated_at),
  }
}

function mapBoardGroup(value: unknown, fallbackState?: string): IntentBoardGroup {
  const dto = rec(value) ?? {}
  const state = normalizeIntentState(dto.state ?? fallbackState)
  const rawItems = dto.items ?? dto.top ?? dto.companies
  return {
    state,
    stateLabel: asString(dto.state_label) ?? INTENT_STATE_LABELS[state],
    count: asInt(dto.count ?? dto.total, Array.isArray(rawItems) ? rawItems.length : 0),
    items: recList(rawItems).map(mapIntentBoardItem),
  }
}

export function mapIntentBoard(value: unknown): IntentBoard {
  const dto = rec(value) ?? {}
  const rawGroups = dto.columns ?? dto.groups ?? dto.board ?? dto.items
  let groups: IntentBoardGroup[] = []
  if (Array.isArray(rawGroups)) {
    groups = rawGroups.map((group) => mapBoardGroup(group))
  } else {
    const groupMap = rec(rawGroups) ?? dto
    groups = Object.entries(groupMap)
      .filter(([state, group]) => state !== 'total' && rec(group) !== null)
      .map(([state, group]) => mapBoardGroup(group, state))
  }
  groups = groups.filter((group) => group.state in INTENT_STATE_LABELS)
  groups.sort(
    (a, b) => INTENT_STATE_ORDER.indexOf(a.state) - INTENT_STATE_ORDER.indexOf(b.state)
  )
  const total = asInt(dto.total, groups.reduce((sum, group) => sum + group.count, 0))
  return { groups, total }
}

/** BE BatchRow / RejectedRow → 统一行结果（scope=company|pool, index 行号）。 */
export function mapIntentImportRow(value: unknown): IntentImportRow {
  const dto = rec(value) ?? {}
  const rawScope = asString(dto.scope)
  const scope = rawScope === 'company' || rawScope === 'pool' ? rawScope : null
  const rawIndex = asNumber(dto.index ?? dto.row ?? dto.line)
  const rawReason = asString(dto.reason) ?? asString(dto.message) ?? asString(dto.error)
  return {
    scope,
    index: rawIndex === null ? null : asInt(rawIndex),
    externalId: asString(dto.external_id) ?? asString(dto.name),
    status: asString(dto.status),
    reason: rawReason ?? '',
    companyId: asNumber(dto.company_id) === null ? null : asInt(dto.company_id),
    poolId: asNumber(dto.pool_id) === null ? null : asInt(dto.pool_id),
  }
}

export function mapIntentImportRows(value: unknown): IntentImportRow[] {
  return recList(value).map(mapIntentImportRow)
}

/** BE IngestResult：created/updated/skipped_locked/skipped_existing/rejected_count/rows。 */
export function mapIntentImportResult(value: unknown): IntentImportResult {
  const outer = rec(value) ?? {}
  const dto = rec(outer.result) ?? outer
  const rows = [...recList(dto.rows).map(mapIntentImportRow)]
  const rejected = recList(dto.rejected).map(mapIntentImportRow)
  const allRows = [...rows, ...rejected]
  return {
    batchId: asNumber(dto.batch_id) === null ? null : asInt(dto.batch_id),
    status: asString(dto.status) ?? 'completed',
    createdCount: asInt(dto.created ?? dto.created_count),
    updatedCount: asInt(dto.updated ?? dto.updated_count),
    skippedLockedCount: asInt(dto.skipped_locked ?? dto.skipped_locked_count),
    skippedExistingCount: asInt(dto.skipped_existing ?? dto.skipped_existing_count),
    rejectedCount: asInt(
      dto.rejected_count,
      allRows.filter((row) => row.status === 'rejected').length
    ),
    totalCompanies: asInt(dto.companies_total ?? dto.total_companies ?? dto.total),
    totalPool: asInt(dto.pool_total ?? dto.total_pool),
    dataRev: asNumber(dto.data_rev) === null ? null : asInt(dto.data_rev),
    rowsTruncated: asBool(dto.rows_truncated) ?? false,
    rows: allRows,
  }
}

export function mapIntentBatchSummary(value: unknown): IntentBatchSummary {
  const dto = rec(value) ?? {}
  return {
    id: asInt(dto.id),
    batchDate: asString(dto.batch_date),
    source: asString(dto.source) ?? '',
    sourceLabel: asString(dto.source_label),
    sourceFileName: asString(dto.source_file_name),
    totalCompanies: asInt(dto.total_companies),
    totalPool: asInt(dto.total_pool),
    createdCount: asInt(dto.created_count),
    updatedCount: asInt(dto.updated_count),
    skippedLockedCount: asInt(dto.skipped_locked_count),
    rejectedCount: asInt(dto.rejected_count),
    status: asString(dto.status) ?? '',
    errorDetail: asString(dto.error_detail),
    createdAt: asString(dto.created_at),
    completedAt: asString(dto.completed_at),
  }
}

export function mapIntentBatchPage(value: unknown): IntentBatchPage {
  if (Array.isArray(value)) {
    return { items: value.map(mapIntentBatchSummary), total: value.length, page: 1, pageSize: value.length }
  }
  const dto = rec(value) ?? {}
  const items = recList(dto.items).map(mapIntentBatchSummary)
  return {
    items,
    total: asInt(dto.total, items.length),
    page: asInt(dto.page, 1),
    pageSize: asInt(dto.page_size, items.length),
  }
}

/** GET /batches/{id}：Batch 字段平铺 + rejected/rows/rows_truncated。 */
export function mapIntentBatchDetail(value: unknown): IntentBatchDetail {
  const dto = rec(value) ?? {}
  return {
    ...mapIntentBatchSummary(value),
    rejected: mapIntentImportRows(dto.rejected),
    rows: mapIntentImportRows(dto.rows),
    rowsTruncated: asBool(dto.rows_truncated) ?? false,
  }
}

/** BE ConvertResult：{company_id, customer_id, company, data_rev}。 */
export function mapIntentConvertResult(value: unknown): IntentConvertResult {
  const dto = rec(value) ?? {}
  const companyDto = dto.company
  return {
    companyId: asInt(dto.company_id ?? dto.converted_customer_id),
    customerId: asInt(dto.customer_id),
    company: rec(companyDto) ? mapIntentCompanyDetail(companyDto) : null,
    dataRev: asNumber(dto.data_rev) === null ? null : asInt(dto.data_rev),
  }
}

export const POOL_STATUS_LABELS = INTENT_POOL_STATUS_LABELS
export const LEVEL_LABELS = INTENT_LEVEL_LABELS
