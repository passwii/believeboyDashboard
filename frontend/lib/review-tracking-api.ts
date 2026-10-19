/**
 * 评论追踪（Amazon Review Tracking）前端 API 层 —— 阶段 C（BLF-1377）。
 *
 * 后端契约（已在 main）：
 *   `backend/app/api/v1/endpoints/amazon_review_tracking.py`
 *   `backend/app/schemas/amazon_review_tracking.py`
 * 类型来源：`frontend/types/api-generated/api.d.ts`（`components['schemas'][...]`）。
 *
 * 与其他域 API 同模式（对齐 `lib/complaint-api.ts` / `lib/inspection-api.ts`）：
 *   - 请求走 `/api/backend/*` 代理，session 鉴权（代理注入 `X-Operator`）；
 *   - 后端 DTO → 页面模型的映射集中在本文件，页面只消费映射后的模型；
 *   - 错误统一抛 `ReviewTrackingApiError`，带 `status` 供页面分流 401 / 403 / 404。
 *
 * 口径纪律（设计稿 §8.3 / §8.5）：
 *   - 「本次没取到」= `null`，绝不能映射成 0；
 *   - `star_count_quality=estimated` 的数量必须带「≈」并标注估算；
 *   - `rating_count`（页面 global ratings）与 `review_count`（有正文的评论数）不互相兜底。
 */
import type { components } from '@/types/api-generated/api'

// ======================== 后端 DTO（生成类型别名）========================

export type TargetDto = components['schemas']['TargetItem']
export type ReviewGroupDto = components['schemas']['ReviewGroupItem']
export type ReviewGroupPatchDto = components['schemas']['ReviewGroupPatch']
export type RatingSnapshotDto = components['schemas']['RatingSnapshotItem']
export type ReviewDto = components['schemas']['ReviewItem']
export type CrawlRunDto = components['schemas']['CrawlRunItem']
export type ExternalLinkDto = components['schemas']['ExternalLinkItem']
export type ExternalTargetDto = components['schemas']['ExternalTargetItem']
export type ExternalTargetCreateDto = components['schemas']['ExternalTargetCreate']

// ======================== 领域枚举（后端字符串，前端显式收敛）========================

export type CaptureStatus = 'success' | 'partial' | 'failed'
export type StarCountQuality = 'exact' | 'estimated' | 'unavailable'
export type VisibilityStatus = 'visible' | 'suspected_removed'
export type IdConfidence = 'original' | 'derived'
export type TargetKind = 'internal_group' | 'external_asin'

/** 未知枚举值兜底用 —— 后端新增状态时不至于渲染空白。 */
export type Loose<T extends string> = T | (string & {})

// ======================== 错误类型 ========================

export class ReviewTrackingApiError extends Error {
  readonly status: number
  readonly detail: string

  constructor(status: number, detail: string) {
    super(detail)
    this.name = 'ReviewTrackingApiError'
    this.status = status
    this.detail = detail
  }
}

/**
 * 错误 → 展示文案。权限/存在性语义按后端约定翻译：
 *   401 未登录 / 会话失效；403 非运营或非管理员；404 不可见目标（不泄露存在性）。
 */
export function describeReviewTrackingError(error: unknown): {
  title: string
  message: string
  status: number | null
} {
  if (error instanceof ReviewTrackingApiError) {
    if (error.status === 401) {
      return { title: '登录状态已失效', message: '请重新登录后再试。', status: 401 }
    }
    if (error.status === 403) {
      return {
        title: '没有访问权限',
        message: '评论追踪仅对运营与管理员开放，请联系管理员开通。',
        status: 403,
      }
    }
    if (error.status === 404) {
      return {
        title: '目标不存在或无权访问',
        message: '该追踪目标不存在，或不在你可见的项目范围内。',
        status: 404,
      }
    }
    return { title: '加载失败', message: error.detail || '请求失败，请稍后重试。', status: error.status }
  }
  const text = error instanceof Error ? error.message : ''
  return { title: '加载失败', message: text || '请求失败，请稍后重试。', status: null }
}

// ======================== 状态文案与色档 ========================

type Tone = 'pos' | 'warn' | 'neg' | 'muted'

const CAPTURE_STATUS_LABELS: Record<CaptureStatus, { label: string; tone: Tone; hint: string }> = {
  success: { label: '成功', tone: 'pos', hint: '评分与评论均已取到' },
  partial: { label: '部分成功', tone: 'warn', hint: '部分字段未取到，缺失项不按 0 计' },
  failed: { label: '失败', tone: 'neg', hint: '本次未取到任何数据' },
}

const VISIBILITY_LABELS: Record<VisibilityStatus, { label: string; tone: Tone }> = {
  visible: { label: '可见', tone: 'pos' },
  suspected_removed: { label: '疑似移除', tone: 'warn' },
}

const ID_CONFIDENCE_LABELS: Record<IdConfidence, { label: string; tone: Tone; hint: string }> = {
  original: { label: '来源 ID', tone: 'muted', hint: '由 Amazon 页面直接提供' },
  derived: { label: '推导 ID', tone: 'warn', hint: '由评论属性指纹推导，正文编辑后可能被判为新评论' },
}

const STAR_COUNT_QUALITY_LABELS: Record<StarCountQuality, string> = {
  exact: '精确数量',
  estimated: '按百分比估算',
  unavailable: '数量未取到',
}

function asCaptureStatus(value: string): CaptureStatus | null {
  return value === 'success' || value === 'partial' || value === 'failed' ? value : null
}
function asVisibilityStatus(value: string): VisibilityStatus | null {
  return value === 'visible' || value === 'suspected_removed' ? value : null
}
function asIdConfidence(value: string): IdConfidence | null {
  return value === 'original' || value === 'derived' ? value : null
}
function asStarCountQuality(value: string): StarCountQuality | null {
  return value === 'exact' || value === 'estimated' || value === 'unavailable' ? value : null
}

export function captureStatusLabel(value: string): { label: string; tone: Tone; hint: string } {
  const known = asCaptureStatus(value)
  if (known) return CAPTURE_STATUS_LABELS[known]
  return { label: value || '未知', tone: 'muted', hint: '' }
}

export function visibilityLabel(value: string): { label: string; tone: Tone } {
  const known = asVisibilityStatus(value)
  if (known) return VISIBILITY_LABELS[known]
  return { label: value || '未知', tone: 'muted' }
}

export function idConfidenceLabel(value: string): { label: string; tone: Tone; hint: string } {
  const known = asIdConfidence(value)
  if (known) return ID_CONFIDENCE_LABELS[known]
  return { label: value || '未知', tone: 'muted', hint: '' }
}

export function starCountQualityLabel(value: string): string {
  const known = asStarCountQuality(value)
  return known ? STAR_COUNT_QUALITY_LABELS[known] : value || '口径未知'
}

export const MISSING_VALUE = '—'
export const MISSING_HINT = '未取到'

// ======================== 页面模型 ========================

export interface ReviewTarget {
  id: number
  kind: Loose<TargetKind>
  kindLabel: string
  groupId: number | null
  projectId: number | null
  projectName: string
  marketplace: string
  asin: string | null
  displayName: string
  isActive: boolean
}

export interface StarBucket {
  star: 1 | 2 | 3 | 4 | 5
  /** 页面原始百分比；null = 本次没取到 */
  percentage: number | null
  /** 数量展示文本：exact 直接数字，estimated 带 ≈，unavailable / null 为 — */
  countText: string
  /** 数量是否可展示（unavailable 不展示数量） */
  countAvailable: boolean
}

export interface RatingSnapshotPoint {
  captureDate: string
  capturedAt: string
  averageRating: number | null
  ratingCount: number | null
  reviewCount: number | null
  stars: StarBucket[]
  starCountQuality: Loose<StarCountQuality>
  starCountQualityLabel: string
  captureStatus: Loose<CaptureStatus>
  captureStatusLabel: string
  captureStatusTone: Tone
  captureStatusHint: string
}

export interface ReviewRow {
  reviewKey: string
  idConfidence: Loose<IdConfidence>
  idConfidenceLabel: string
  idConfidenceHint: string
  reviewerName: string | null
  rating: number | null
  title: string | null
  body: string | null
  reviewDate: string | null
  verifiedPurchase: boolean | null
  helpfulCount: number | null
  firstSeenAt: string
  lastSeenAt: string
  visibility: Loose<VisibilityStatus>
  visibilityLabel: string
  visibilityTone: Tone
}

export interface CrawlRunRow {
  id: number
  startedAt: string
  finishedAt: string | null
  status: Loose<CaptureStatus>
  statusLabel: string
  statusTone: Tone
  isCompleteList: boolean
  reviewsSeen: number | null
  ratingsCaptured: boolean
  asinScraped: string | null
  errorMessage: string | null
}

export interface ReviewGroup {
  id: number
  projectId: number
  marketplace: string
  name: string
  description: string | null
  representativeId: number | null
  memberIds: number[]
  isActive: boolean
}

export interface ExternalTarget {
  id: number
  marketplace: string
  asin: string | null
  displayName: string
  isActive: boolean
  links: Array<{ id: number; shopId: number; isActive: boolean }>
  activeLinkCount: number
}

// ======================== 映射层 ========================

function orMissing(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function formatNumber(value: number, digits = 0): string {
  return value.toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

/** 平均分展示：null → —，否则保留一位小数（页面原始值可能是 2.6 / 4 / 4.75）。 */
export function formatAverageRating(value: number | null): string {
  return value === null ? MISSING_VALUE : value.toFixed(1)
}

/** 评分数 / 评论数展示：null → —（**不是 0**）。 */
export function formatCount(value: number | null): string {
  return value === null ? MISSING_VALUE : formatNumber(value)
}

/**
 * 星数展示。三档口径：
 *   exact       → 精确数字（如 `3`）
 *   estimated   → `≈3`（按页面百分比与评分数推算，不冒称精确）
 *   unavailable → `—`（本次没取到数量，仅有百分比时只显示百分比）
 */
export function formatStarCount(count: number | null, quality: string): string {
  const known = asStarCountQuality(quality)
  if (count === null || known === 'unavailable') return MISSING_VALUE
  if (known === 'estimated') return `≈${formatNumber(count)}`
  return formatNumber(count)
}

export function isStarCountAvailable(count: number | null, quality: string): boolean {
  const known = asStarCountQuality(quality)
  return count !== null && known !== 'unavailable'
}

function buildStars(
  snapshot: Pick<
    RatingSnapshotDto,
    | 'star_1_percentage'
    | 'star_2_percentage'
    | 'star_3_percentage'
    | 'star_4_percentage'
    | 'star_5_percentage'
    | 'star_1_count'
    | 'star_2_count'
    | 'star_3_count'
    | 'star_4_count'
    | 'star_5_count'
    | 'star_count_quality'
  >
): StarBucket[] {
  const rows: Array<[1 | 2 | 3 | 4 | 5, number | null, number | null]> = [
    [5, orMissing(snapshot.star_5_percentage), orMissing(snapshot.star_5_count)],
    [4, orMissing(snapshot.star_4_percentage), orMissing(snapshot.star_4_count)],
    [3, orMissing(snapshot.star_3_percentage), orMissing(snapshot.star_3_count)],
    [2, orMissing(snapshot.star_2_percentage), orMissing(snapshot.star_2_count)],
    [1, orMissing(snapshot.star_1_percentage), orMissing(snapshot.star_1_count)],
  ]
  return rows.map(([star, percentage, count]) => ({
    star,
    percentage,
    countText: formatStarCount(count, snapshot.star_count_quality),
    countAvailable: isStarCountAvailable(count, snapshot.star_count_quality),
  }))
}

export function mapRatingSnapshot(dto: RatingSnapshotDto): RatingSnapshotPoint {
  const status = captureStatusLabel(dto.capture_status)
  return {
    captureDate: dto.capture_date,
    capturedAt: dto.captured_at,
    averageRating: orMissing(dto.average_rating),
    ratingCount: orMissing(dto.rating_count),
    reviewCount: orMissing(dto.review_count),
    stars: buildStars(dto),
    starCountQuality: dto.star_count_quality,
    starCountQualityLabel: starCountQualityLabel(dto.star_count_quality),
    captureStatus: dto.capture_status,
    captureStatusLabel: status.label,
    captureStatusTone: status.tone,
    captureStatusHint: status.hint,
  }
}

export function mapReview(dto: ReviewDto): ReviewRow {
  const confidence = idConfidenceLabel(dto.id_confidence)
  const visibility = visibilityLabel(dto.visibility_status)
  return {
    reviewKey: dto.review_key,
    idConfidence: dto.id_confidence,
    idConfidenceLabel: confidence.label,
    idConfidenceHint: confidence.hint,
    reviewerName: dto.reviewer_name,
    rating: orMissing(dto.rating),
    title: dto.title,
    body: dto.body,
    reviewDate: dto.review_date,
    verifiedPurchase: dto.verified_purchase,
    helpfulCount: orMissing(dto.helpful_count),
    firstSeenAt: dto.first_seen_at,
    lastSeenAt: dto.last_seen_at,
    visibility: dto.visibility_status,
    visibilityLabel: visibility.label,
    visibilityTone: visibility.tone,
  }
}

export function mapCrawlRun(dto: CrawlRunDto): CrawlRunRow {
  const status = captureStatusLabel(dto.status)
  return {
    id: dto.id,
    startedAt: dto.started_at,
    finishedAt: dto.finished_at,
    status: dto.status,
    statusLabel: status.label,
    statusTone: status.tone,
    isCompleteList: dto.is_complete_list,
    reviewsSeen: orMissing(dto.reviews_seen),
    ratingsCaptured: dto.ratings_captured,
    asinScraped: dto.asin_scraped,
    errorMessage: dto.error_message,
  }
}

const KIND_LABELS: Record<TargetKind, string> = {
  internal_group: '内部共享组',
  external_asin: '外部 ASIN',
}

export function mapTarget(dto: TargetDto, projectNameById?: ReadonlyMap<number, string>): ReviewTarget {
  const projectId = dto.project_id
  const projectName =
    projectId === null
      ? '外部竞品'
      : (projectNameById?.get(projectId) ?? `项目 #${projectId}`)
  const kind = dto.kind
  return {
    id: dto.id,
    kind,
    kindLabel: KIND_LABELS[kind as TargetKind] ?? kind,
    groupId: dto.group_id,
    projectId,
    projectName,
    marketplace: dto.marketplace,
    asin: dto.asin,
    displayName: dto.display_name?.trim() || dto.asin || `目标 #${dto.id}`,
    isActive: dto.is_active,
  }
}

export function mapReviewGroup(dto: ReviewGroupDto): ReviewGroup {
  return {
    id: dto.id,
    projectId: dto.project_id,
    marketplace: dto.marketplace,
    name: dto.name,
    description: dto.description,
    representativeId: dto.representative_id,
    memberIds: [...dto.member_ids],
    isActive: dto.is_active,
  }
}

export function mapExternalTarget(dto: ExternalTargetDto): ExternalTarget {
  const links = (dto.links ?? []).map((link) => ({
    id: link.id,
    shopId: link.shop_id,
    isActive: link.is_active,
  }))
  return {
    id: dto.id,
    marketplace: dto.marketplace,
    asin: dto.asin,
    displayName: dto.display_name?.trim() || dto.asin || `目标 #${dto.id}`,
    isActive: dto.is_active,
    links,
    activeLinkCount: links.filter((link) => link.isActive).length,
  }
}

/**
 * reviews / runs 接口没有 total，按「返回行数 == limit」判定还有下一页。
 * 传 limit 而不是固定常量——调用方换页大小时判定同样成立。
 */
export function hasMorePage(returnedCount: number, limit: number): boolean {
  return returnedCount >= limit
}

// ======================== 传输层 ========================

const API_BASE = '/api/backend'
const BASE_PATH = 'api/v1/amazon-review-tracking'

function resolveApiUrl(path: string): string {
  return `${API_BASE}/${BASE_PATH}/${path.replace(/^\/+/, '')}`
}

function buildQuery(entries: Record<string, string | number | boolean | null | undefined>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(entries)) {
    if (value === null || value === undefined || value === '') continue
    params.set(key, String(value))
  }
  const query = params.toString()
  return query ? `?${query}` : ''
}

async function parseErrorDetail(response: Response): Promise<string> {
  let raw = ''
  try {
    raw = await response.text()
  } catch {
    raw = ''
  }
  const trimmed = raw.trim()
  if (!trimmed) return `请求失败 (${response.status})`
  try {
    const payload = JSON.parse(trimmed) as { detail?: unknown; message?: unknown }
    if (typeof payload.detail === 'string' && payload.detail.trim()) return payload.detail
    if (typeof payload.message === 'string' && payload.message.trim()) return payload.message
  } catch {
    return trimmed.slice(0, 300)
  }
  return trimmed.slice(0, 300)
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(resolveApiUrl(path), {
    ...init,
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  if (!response.ok) {
    throw new ReviewTrackingApiError(response.status, await parseErrorDetail(response))
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

// ======================== 读接口 ========================

export interface TargetQuery {
  projectId?: number | null
  marketplace?: string | null
  kind?: TargetKind | null
  isActive?: boolean | null
  limit?: number
  offset?: number
}

export async function fetchTargets(
  query: TargetQuery = {},
  projectNameById?: ReadonlyMap<number, string>
): Promise<ReviewTarget[]> {
  const dtos = await request<TargetDto[]>(
    `targets${buildQuery({
      project_id: query.projectId ?? null,
      marketplace: query.marketplace ?? null,
      kind: query.kind ?? null,
      is_active: query.isActive ?? null,
      limit: query.limit ?? null,
      offset: query.offset ?? null,
    })}`
  )
  return dtos.map((dto) => mapTarget(dto, projectNameById))
}

export async function fetchRatingSnapshots(
  targetId: number,
  query: { from?: string | null; to?: string | null; limit?: number; offset?: number } = {}
): Promise<RatingSnapshotPoint[]> {
  const dtos = await request<RatingSnapshotDto[]>(
    `targets/${targetId}/rating-snapshots${buildQuery({
      from: query.from ?? null,
      to: query.to ?? null,
      limit: query.limit ?? null,
      offset: query.offset ?? null,
    })}`
  )
  return dtos.map(mapRatingSnapshot)
}

export async function fetchReviews(
  targetId: number,
  query: {
    visibilityStatus?: VisibilityStatus | null
    reviewDateFrom?: string | null
    reviewDateTo?: string | null
    limit?: number
    offset?: number
  } = {}
): Promise<ReviewRow[]> {
  const dtos = await request<ReviewDto[]>(
    `targets/${targetId}/reviews${buildQuery({
      visibility_status: query.visibilityStatus ?? null,
      review_date_from: query.reviewDateFrom ?? null,
      review_date_to: query.reviewDateTo ?? null,
      limit: query.limit ?? null,
      offset: query.offset ?? null,
    })}`
  )
  return dtos.map(mapReview)
}

export async function fetchCrawlRuns(
  targetId: number,
  query: { limit?: number; offset?: number } = {}
): Promise<CrawlRunRow[]> {
  const dtos = await request<CrawlRunDto[]>(
    `targets/${targetId}/runs${buildQuery({
      limit: query.limit ?? null,
      offset: query.offset ?? null,
    })}`
  )
  return dtos.map(mapCrawlRun)
}

export async function fetchExternalTargets(): Promise<ExternalTarget[]> {
  const dtos = await request<ExternalTargetDto[]>('external-targets')
  return dtos.map(mapExternalTarget)
}

// ======================== 外部竞品写接口（管理员）========================

export async function createExternalTarget(payload: {
  marketplace: string
  asin: string
  shopId?: number | null
  displayName?: string | null
}): Promise<ExternalTarget> {
  const body: ExternalTargetCreateDto = {
    marketplace: payload.marketplace.trim().toUpperCase(),
    asin: payload.asin.trim().toUpperCase(),
  }
  if (payload.shopId) body.shop_id = payload.shopId
  if (payload.displayName?.trim()) body.display_name = payload.displayName.trim()
  const dto = await request<ExternalTargetDto>('external-targets', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  return mapExternalTarget(dto)
}

export async function addExternalLink(targetId: number, shopId: number): Promise<{ id: number; shopId: number; isActive: boolean }> {
  const dto = await request<ExternalLinkDto>(`targets/${targetId}/external-links`, {
    method: 'POST',
    body: JSON.stringify({ shop_id: shopId }),
  })
  return { id: dto.id, shopId: dto.shop_id, isActive: dto.is_active }
}

/** 移除店铺关联是软删：后端只置 `is_active=false`，历史与目标数据保留。 */
export async function removeExternalLink(
  targetId: number,
  linkId: number
): Promise<{ id: number; shopId: number; isActive: boolean }> {
  const dto = await request<ExternalLinkDto>(`targets/${targetId}/external-links/${linkId}`, {
    method: 'DELETE',
  })
  return { id: dto.id, shopId: dto.shop_id, isActive: dto.is_active }
}

// ======================== 内部共享组（仅管理员）========================

export async function fetchReviewGroups(query: {
  projectId?: number | null
  marketplace?: string | null
  isActive?: boolean | null
} = {}): Promise<ReviewGroup[]> {
  const dtos = await request<ReviewGroupDto[]>(
    `groups${buildQuery({
      project_id: query.projectId ?? null,
      marketplace: query.marketplace ?? null,
      is_active: query.isActive ?? null,
    })}`
  )
  return dtos.map(mapReviewGroup)
}

export async function createReviewGroup(payload: {
  projectId: number
  marketplace: string
  name: string
  description?: string | null
  memberIds: number[]
  representativeId: number
}): Promise<ReviewGroup> {
  const dto = await request<ReviewGroupDto>('groups', {
    method: 'POST',
    body: JSON.stringify({
      project_id: payload.projectId,
      marketplace: payload.marketplace.trim().toUpperCase(),
      name: payload.name,
      description: payload.description ?? null,
      member_ids: payload.memberIds,
      representative_id: payload.representativeId,
    }),
  })
  return mapReviewGroup(dto)
}

/**
 * 改组。后端 PATCH 禁止 `name` / `member_ids` / `representative_id` 传 `null`
 * （422），因此这里只序列化「显式提供且非空」的字段；改名/改成员/换代表三态由
 * 调用方按需传。`description` 允许 `null`（清空说明）。
 */
export async function patchReviewGroup(
  groupId: number,
  patch: {
    name?: string
    description?: string | null
    memberIds?: number[]
    representativeId?: number
  }
): Promise<ReviewGroup> {
  const body: ReviewGroupPatchDto = {}
  if (patch.name !== undefined) body.name = patch.name
  if (patch.description !== undefined) body.description = patch.description
  if (patch.memberIds !== undefined) body.member_ids = patch.memberIds
  if (patch.representativeId !== undefined) body.representative_id = patch.representativeId
  const dto = await request<ReviewGroupDto>(`groups/${groupId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
  return mapReviewGroup(dto)
}

export async function deactivateReviewGroup(groupId: number): Promise<ReviewGroup> {
  const dto = await request<ReviewGroupDto>(`groups/${groupId}/deactivate`, { method: 'POST' })
  return mapReviewGroup(dto)
}
