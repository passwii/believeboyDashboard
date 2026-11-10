/**
 * 意向客户（crm_intent）前端领域类型。
 *
 * 字段口径见 docs/superpowers/specs/2026-11-10-crm-intent-workbench-design.md §3/§5；
 * 服务端统计（meta.stats）是唯一统计口径，前端不再自行派生。
 */

export type IntentScope = 'mine' | 'all' | 'sea'

export type IntentTab = 'intent' | 'pool' | 'board'

export type IntentView = 'card' | 'table'

export type IntentLevel = 'A' | 'B' | 'C' | 'D'

export type IntentState =
  | 'none'
  | 'contacted'
  | 'wechat'
  | 'quoted'
  | 'negotiating'
  | 'won'
  | 'hold'
  | 'mismatch'

export type IntentSort = 'score' | 'name' | 'screened'

export type IntentPhoneSource = 'list' | 'manual' | 'ai'

export type IntentPoolStatus = 'pending' | 'screened' | 'ignored'

export const INTENT_LEVEL_ORDER: readonly IntentLevel[] = ['A', 'B', 'C', 'D']

export const INTENT_LEVEL_LABELS: Record<IntentLevel, string> = {
  A: '强意向',
  B: '可培育',
  C: '信息不足',
  D: '暂不匹配',
}

export const INTENT_LEVEL_DESCRIPTIONS: Record<IntentLevel, string> = {
  A: '明确跨境 / 代运营采购信号',
  B: '产品适合零售跨境，暂无采购信号',
  C: '公开信息不足，待补',
  D: '形态或渠道不适合零售跨境',
}

/** 级别只用 Warm 的 accent / neutral 两个 tone + 明确文字（A=accent，其余 neutral）。 */
export const INTENT_LEVEL_TONES: Record<IntentLevel, 'accent' | 'neutral'> = {
  A: 'accent',
  B: 'neutral',
  C: 'neutral',
  D: 'neutral',
}

export const INTENT_STATE_ORDER: readonly IntentState[] = [
  'none',
  'contacted',
  'wechat',
  'quoted',
  'negotiating',
  'won',
  'hold',
  'mismatch',
]

export const INTENT_STATE_LABELS: Record<IntentState, string> = {
  none: '未联系',
  contacted: '已联系',
  wechat: '已加微信',
  quoted: '已报价',
  negotiating: '谈判中',
  won: '已成交',
  hold: '暂搁置',
  mismatch: '不匹配',
}

/**
 * 8 态 → Warm 四个 tone（设计稿 §8.2）：已成交=positive；
 * 已报价/谈判中=accent；其余 neutral；不匹配=negative。始终带文字。
 */
export const INTENT_STATE_TONES: Record<
  IntentState,
  'neutral' | 'accent' | 'positive' | 'negative'
> = {
  none: 'neutral',
  contacted: 'neutral',
  wechat: 'neutral',
  quoted: 'accent',
  negotiating: 'accent',
  won: 'positive',
  hold: 'neutral',
  mismatch: 'negative',
}

export const INTENT_SORT_ORDER: readonly IntentSort[] = ['score', 'name', 'screened']

export const INTENT_SORT_LABELS: Record<IntentSort, string> = {
  score: '意向分从高到低',
  name: '企业名称 A→Z',
  screened: '筛选日期从新到旧',
}

export const INTENT_PHONE_SOURCE_LABELS: Record<IntentPhoneSource, string> = {
  list: '名录',
  manual: '补录',
  ai: 'AI 补充',
}

export const INTENT_POOL_STATUS_LABELS: Record<IntentPoolStatus, string> = {
  pending: '待筛',
  screened: '已筛',
  ignored: '已忽略',
}

export const INTENT_SCOPE_ORDER: readonly IntentScope[] = ['mine', 'all', 'sea']

export const INTENT_SCOPE_LABELS: Record<IntentScope, string> = {
  mine: '我的',
  all: '全部',
  sea: '待领取',
}

export const INTENT_TAB_ORDER: readonly IntentTab[] = ['intent', 'pool', 'board']

export const INTENT_TAB_LABELS: Record<IntentTab, string> = {
  intent: '意向客户',
  pool: '待筛池',
  board: '跟进看板',
}

export const INTENT_VIEW_ORDER: readonly IntentView[] = ['card', 'table']

export const INTENT_VIEW_LABELS: Record<IntentView, string> = {
  card: '卡片',
  table: '表格',
}

/** 默认分页与池分页（设计稿 §8.3：待筛池 60/页）。 */
export const INTENT_PAGE_SIZE = 50
export const INTENT_POOL_PAGE_SIZE = 60

/** 轮询间隔（设计稿 D5：默认 15s；document.hidden 暂停）。 */
export const INTENT_POLL_INTERVAL_MS = 15_000

/** 备注自动保存 debounce（设计稿 §4.4：900ms + beforeunload/visibilitychange flush）。 */
export const INTENT_NOTE_DEBOUNCE_MS = 900

export interface IntentPhone {
  id: number
  raw: string
  normalized: string
  source: IntentPhoneSource
  isValid: boolean
  createdBy?: string | null
}

export interface IntentOwner {
  id: string
  name: string
}

export interface IntentFollowup {
  state: IntentState
  stateLabel: string
  note: string
  lastContactAt: string | null
  nextContactAt: string | null
  version: number
  updatedAt?: string | null
  updatedBy?: string | null
}

export interface IntentCompany {
  id: number
  batchId: number | null
  batchDate: string | null
  externalId: string | null
  name: string
  creditCode: string | null
  legalPerson: string | null
  province: string | null
  city: string | null
  foundedYear: number | null
  registeredCapitalWan: number | null
  products: string | null
  category: string | null
  channels: string[]
  trademarks: string[]
  trademarkCount: number
  intentLevel: IntentLevel
  intentScore: number | null
  intentBasis: string | null
  amazonFit: string | null
  walmartFit: string | null
  sources: string[]
  risks: string | null
  screenedAt: string | null
  phoneNote: string | null
  owner: IntentOwner | null
  humanTouched: boolean
  convertedCustomerId: number | null
  convertedAt: string | null
  phones: IntentPhone[]
  followup: IntentFollowup
}

export interface IntentSharedPhoneGroup {
  phoneNormalized: string
  raw: string
  companies: Array<{ id: number; name: string; intentLevel: IntentLevel }>
  pool: Array<{ id: number; name: string; status: IntentPoolStatus }>
}

export interface IntentCompanyDetail extends IntentCompany {
  sharedPhones: IntentSharedPhoneGroup[]
}

export interface IntentStats {
  total: number
  byLevel: Record<IntentLevel, number>
  withPhone: number
  contacted: number
  followedUp: number
  poolTotal: number
  dupGroups: number
  dueCount: number
}

export interface IntentCityFacet {
  province: string
  cities: string[]
}

export interface IntentStateFacet {
  value: IntentState
  label: string
}

export interface IntentFacets {
  levels: IntentLevel[]
  categories: string[]
  channels: string[]
  provinces: string[]
  cities: IntentCityFacet[]
  states: IntentStateFacet[]
}

export interface IntentBatch {
  id: number | null
  batchDate: string | null
  updatedAt: string | null
  total: number
  poolTotal: number
  source: string | null
  sourceFileName: string | null
}

export interface IntentMeta {
  batch: IntentBatch | null
  stats: IntentStats
  facets: IntentFacets
  dataRev: number
  followupRev: number
  changed: boolean
  serverTime: string | null
}

export interface IntentMetaRevs {
  dataRev: number
  followupRev: number
}

export interface IntentListParams {
  scope: IntentScope
  q?: string
  level?: IntentLevel
  category?: string
  channel?: string
  province?: string
  city?: string
  state?: IntentState
  withPhone?: boolean
  dup?: boolean
  due?: boolean
  sort?: IntentSort
  page?: number
  pageSize?: number
}

export interface IntentPage<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

export type IntentCompanyPage = IntentPage<IntentCompany>

export interface IntentPoolItem {
  id: number
  name: string
  legalPerson: string | null
  website: string | null
  channel: string | null
  channels: string[]
  channelSource: string | null
  status: IntentPoolStatus
  phones: IntentPhone[]
}

export type IntentPoolPage = IntentPage<IntentPoolItem>

export interface IntentPoolParams {
  q?: string
  page?: number
  pageSize?: number
}

/** BE BoardItem：id/name/intent_level/intent_level_label/intent_score/next_contact_at/owner/updated_at（无手机号）。 */
export interface IntentBoardItem {
  id: number
  name: string
  intentLevel: IntentLevel
  intentLevelLabel: string
  intentScore: number | null
  nextContactAt: string | null
  owner: IntentOwner | null
  updatedAt: string | null
}

export interface IntentBoardGroup {
  state: IntentState
  stateLabel: string
  count: number
  items: IntentBoardItem[]
}

export interface IntentBoard {
  groups: IntentBoardGroup[]
  total: number
}

export interface IntentFollowupInput {
  state?: IntentState
  note?: string
  lastContactAt?: string | null
  nextContactAt?: string | null
  validPhones?: string[]
}

/** BE ConvertResult：{company_id, customer_id, company, data_rev}。 */
export interface IntentConvertResult {
  companyId: number
  customerId: number
  company: IntentCompanyDetail | null
  dataRev: number | null
}

/** BE BatchRow / RejectedRow：scope=company|pool，index 行号。 */
export interface IntentImportRow {
  scope: 'company' | 'pool' | null
  index: number | null
  externalId: string | null
  status: string | null
  reason: string
  companyId: number | null
  poolId: number | null
}

/** BE IngestResult（AI/人工共用 ingest 的返回）。 */
export interface IntentImportResult {
  batchId: number | null
  status: string
  createdCount: number
  updatedCount: number
  skippedLockedCount: number
  skippedExistingCount: number
  rejectedCount: number
  totalCompanies: number
  totalPool: number
  dataRev: number | null
  rowsTruncated: boolean
  rows: IntentImportRow[]
}

/** BE Batch（GET /batches 列表项）。 */
export interface IntentBatchSummary {
  id: number
  batchDate: string | null
  source: string
  sourceLabel: string | null
  sourceFileName: string | null
  totalCompanies: number
  totalPool: number
  createdCount: number
  updatedCount: number
  skippedLockedCount: number
  rejectedCount: number
  status: string
  errorDetail: string | null
  createdAt: string | null
  completedAt: string | null
}

export type IntentBatchPage = IntentPage<IntentBatchSummary>

/** BE BatchDetail（GET /batches/{id}）：Batch 内嵌 + rejected/rows/rows_truncated。 */
export interface IntentBatchDetail extends IntentBatchSummary {
  rejected: IntentImportRow[]
  rows: IntentImportRow[]
  rowsTruncated: boolean
}

export interface IntentExportParams {
  scope: IntentScope
  q?: string
  level?: IntentLevel
  category?: string
  channel?: string
  province?: string
  city?: string
  state?: IntentState
  withPhone?: boolean
  dup?: boolean
  due?: boolean
  sort?: IntentSort
}

export interface IntentExportFile {
  blob: Blob
  filename: string | null
}

/** 请求可选项：列表请求支持 AbortSignal；写请求支持 keepalive（beforeunload flush）。 */
export interface IntentRequestOptions {
  signal?: AbortSignal
}

export interface IntentWriteOptions {
  keepalive?: boolean
}
