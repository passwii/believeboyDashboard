/**
 * 意向客户 HTTP 客户端。
 *
 * BASE = /api/backend/v1/crm/intent：经 Next 代理访问 Go Gateway，
 * 鉴权头由代理注入（见 app/api/backend/[...path]/route.ts），浏览器不持 API key。
 */
import type { IntentClient } from './client'
import {
  mapIntentBatchDetail,
  mapIntentBatchPage,
  mapIntentBoard,
  mapIntentCompanyDetail,
  mapIntentCompanyPage,
  mapIntentConvertResult,
  mapIntentFollowupResponse,
  mapIntentImportResult,
  mapIntentMeta,
  mapIntentPoolPage,
  type IntentCompanyPageDto,
  type IntentMetaDto,
} from './dto-mappers'
import type { IntentCompanyDetailOptions } from './client'
import type {
  IntentCompanyDetail,
  IntentExportFile,
  IntentExportParams,
  IntentFollowup,
  IntentFollowupInput,
  IntentListParams,
  IntentMeta,
  IntentMetaRevs,
  IntentProfileInput,
  IntentRequestOptions,
  IntentScope,
  IntentWriteOptions,
} from './types'

export const INTENT_API_BASE = '/api/backend/v1/crm/intent'

/** 带 HTTP status 的请求错误；调用方按 status / detail.code 区分冲突与普通失败。 */
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

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

async function parseApiError(res: Response, fallback: string): Promise<ApiError> {
  let body: unknown
  let message = fallback
  try {
    body = await res.json()
    const record = readRecord(body)
    if (record) {
      const detail = record.detail
      const detailRecord = readRecord(detail)
      if (typeof detail === 'string') message = detail
      else if (detailRecord) {
        message =
          (typeof detailRecord.message === 'string' ? detailRecord.message : undefined) ??
          (typeof detailRecord.code === 'string' ? detailRecord.code : undefined) ??
          message
      } else if (record.message && typeof record.message === 'string') {
        message = record.message
      }
    }
  } catch {
    // 非 JSON 错误体（代理网关错误），保留默认消息
  }
  return new ApiError(res.status, message, body)
}

async function request<T>(path: string, init: RequestInit = {}, options?: IntentWriteOptions): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${INTENT_API_BASE}${path}`, {
      ...init,
      keepalive: options?.keepalive ?? init.keepalive,
      headers: init.body instanceof FormData ? init.headers : { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    })
  } catch (error) {
    throw new Error(`网络错误：${(error as Error)?.message ?? String(error)}`)
  }
  if (!res.ok) throw await parseApiError(res, `意向客户请求失败（${res.status}）`)
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

async function requestForm<T>(path: string, form: FormData): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${INTENT_API_BASE}${path}`, { method: 'POST', body: form })
  } catch (error) {
    throw new Error(`网络错误：${(error as Error)?.message ?? String(error)}`)
  }
  if (!res.ok) throw await parseApiError(res, `导入失败（${res.status}）`)
  return (await res.json()) as T
}

function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null
  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(header)
  if (utf8Match) {
    try {
      return decodeURIComponent(utf8Match[1].trim())
    } catch {
      return utf8Match[1].trim()
    }
  }
  const plainMatch = /filename="?([^";]+)"?/i.exec(header)
  return plainMatch ? plainMatch[1].trim() : null
}

async function requestFile(path: string, options?: IntentRequestOptions): Promise<IntentExportFile> {
  let res: Response
  try {
    res = await fetch(`${INTENT_API_BASE}${path}`, { signal: options?.signal })
  } catch (error) {
    throw new Error(`网络错误：${(error as Error)?.message ?? String(error)}`)
  }
  if (!res.ok) throw await parseApiError(res, `导出失败（${res.status}）`)
  return {
    blob: await res.blob(),
    filename: filenameFromDisposition(res.headers.get('content-disposition')),
  }
}

function appendListQuery(qs: URLSearchParams, params: IntentListParams | IntentExportParams): void {
  qs.set('scope', params.scope)
  if (params.q) qs.set('q', params.q)
  if (params.level) qs.set('level', params.level)
  if (params.category) qs.set('category', params.category)
  if (params.channel) qs.set('channel', params.channel)
  if (params.province) qs.set('province', params.province)
  if (params.city) qs.set('city', params.city)
  if (params.state) qs.set('state', params.state)
  if (params.withPhone) qs.set('with_phone', 'true')
  if (params.dup) qs.set('dup', 'true')
  if (params.due) qs.set('due', 'true')
  if (params.sort) qs.set('sort', params.sort)
}

function followupBody(input: IntentFollowupInput): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (input.state !== undefined) body.state = input.state
  if (input.note !== undefined) body.note = input.note
  if (input.lastContactAt !== undefined) body.last_contact_at = input.lastContactAt
  if (input.nextContactAt !== undefined) body.next_contact_at = input.nextContactAt
  if (input.validPhones !== undefined) body.valid_phones = input.validPhones
  return body
}

export class HttpIntentClient implements IntentClient {
  async getMeta(
    scope: IntentScope,
    revs?: IntentMetaRevs,
    options?: IntentRequestOptions
  ): Promise<IntentMeta> {
    const qs = new URLSearchParams({ scope })
    if (revs) {
      qs.set('data_rev', String(revs.dataRev))
      qs.set('followup_rev', String(revs.followupRev))
    }
    const dto = await request<IntentMetaDto>(`/meta?${qs.toString()}`, { signal: options?.signal })
    return mapIntentMeta(dto)
  }

  async listCompanies(params: IntentListParams, options?: IntentRequestOptions) {
    const qs = new URLSearchParams()
    appendListQuery(qs, params)
    qs.set('page', String(params.page ?? 1))
    qs.set('page_size', String(params.pageSize ?? 50))
    const dto = await request<IntentCompanyPageDto>(`/companies?${qs.toString()}`, {
      signal: options?.signal,
    })
    return mapIntentCompanyPage(dto)
  }

  async getCompany(id: number, options?: IntentCompanyDetailOptions) {
    const qs = new URLSearchParams()
    if (options?.scope) qs.set('scope', options.scope)
    const query = qs.toString()
    const dto = await request<unknown>(`/companies/${id}${query ? `?${query}` : ''}`, {
      signal: options?.signal,
    })
    return mapIntentCompanyDetail(dto)
  }

  async updateFollowup(
    id: number,
    input: IntentFollowupInput,
    version: number,
    options?: IntentWriteOptions
  ): Promise<IntentFollowup> {
    // 设计 §4.4：PATCH 必须带 If-Match；version=0（尚无跟进行）也发送，避免并发首写覆盖。
    const headers: Record<string, string> = { 'If-Match': String(version) }
    const dto = await request<unknown>(
      `/companies/${id}/followup`,
      { method: 'PATCH', headers, body: JSON.stringify(followupBody(input)) },
      options
    )
    return mapIntentFollowupResponse(dto)
  }

  async claimCompany(id: number, options?: IntentWriteOptions) {
    const dto = await request<unknown>(
      `/companies/${id}/claim`,
      { method: 'POST', body: JSON.stringify({}) },
      options
    )
    return mapIntentCompanyDetail(dto)
  }

  async addPhone(id: number, raw: string, options?: IntentWriteOptions) {
    const dto = await request<unknown>(
      `/companies/${id}/phones`,
      { method: 'POST', body: JSON.stringify({ phone_raw: raw }) },
      options
    )
    return mapIntentCompanyDetail(dto)
  }

  async setPhoneValid(
    id: number,
    phoneId: number,
    isValid: boolean,
    options?: IntentWriteOptions
  ) {
    const dto = await request<unknown>(
      `/companies/${id}/phones/${phoneId}`,
      { method: 'PATCH', body: JSON.stringify({ is_valid: isValid }) },
      options
    )
    return mapIntentCompanyDetail(dto)
  }

  async deletePhone(id: number, phoneId: number, options?: IntentWriteOptions) {
    const dto = await request<unknown>(
      `/companies/${id}/phones/${phoneId}`,
      { method: 'DELETE' },
      options
    )
    return mapIntentCompanyDetail(dto)
  }

  async updateProfile(id: number, input: IntentProfileInput, options?: IntentWriteOptions) {
    const body = {
      credit_code: input.creditCode,
      legal_person: input.legalPerson,
      province: input.province,
      city: input.city,
      founded_year: input.foundedYear,
      registered_capital_wan: input.registeredCapitalWan,
      products: input.products,
      category: input.category,
      channel: input.channel,
      channels: input.channels,
      channel_source: input.channelSource,
      trademarks: input.trademarks,
      trademark_count: input.trademarkCount,
      intent_level: input.intentLevel,
      intent_score: input.intentScore,
      intent_basis: input.intentBasis,
      amazon_fit: input.amazonFit,
      walmart_fit: input.walmartFit,
      sources: input.sources,
      risks: input.risks,
      screened_at: input.screenedAt,
      phone_note: input.phoneNote,
    }
    const dto = await request<unknown>(
      `/companies/${id}/profile`,
      { method: 'PATCH', body: JSON.stringify(body) },
      options
    )
    return mapIntentCompanyDetail(dto)
  }

  async convertCompany(id: number, options?: IntentWriteOptions) {
    const dto = await request<unknown>(
      `/companies/${id}/convert`,
      { method: 'POST', body: JSON.stringify({}) },
      options
    )
    return mapIntentConvertResult(dto)
  }

  async getBoard(scope: IntentScope, options?: IntentRequestOptions) {
    const dto = await request<unknown>(`/board?${new URLSearchParams({ scope }).toString()}`, {
      signal: options?.signal,
    })
    return mapIntentBoard(dto)
  }

  async getPool(params: { q?: string; page?: number; pageSize?: number }, options?: IntentRequestOptions) {
    const qs = new URLSearchParams()
    if (params.q) qs.set('q', params.q)
    qs.set('page', String(params.page ?? 1))
    qs.set('page_size', String(params.pageSize ?? 60))
    const dto = await request<unknown>(`/pool?${qs.toString()}`, { signal: options?.signal })
    return mapIntentPoolPage(dto)
  }

  async exportCsv(params: IntentExportParams, options?: IntentRequestOptions) {
    const qs = new URLSearchParams()
    appendListQuery(qs, params)
    return requestFile(`/export?${qs.toString()}`, options)
  }

  async uploadBatch(form: FormData) {
    const dto = await requestForm<unknown>('/batches/upload', form)
    return mapIntentImportResult(dto)
  }

  async listBatches(page = 1, pageSize = 20, options?: IntentRequestOptions) {
    const qs = new URLSearchParams()
    qs.set('page', String(page))
    qs.set('page_size', String(pageSize))
    const dto = await request<unknown>(`/batches?${qs.toString()}`, { signal: options?.signal })
    return mapIntentBatchPage(dto)
  }

  async getBatch(id: number, options?: IntentRequestOptions) {
    const dto = await request<unknown>(`/batches/${id}`, { signal: options?.signal })
    return mapIntentBatchDetail(dto)
  }
}

// ===== 错误语义辅助 =====

/** 409 + INTENT_VERSION_CONFLICT：跟进记录被他人更新。 */
export function isIntentVersionConflict(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 409) return false
  const body = readRecord(error.body)
  const detail = body ? readRecord(body.detail) : null
  const code =
    (detail && typeof detail.code === 'string' ? detail.code : undefined) ??
    (body && typeof body.code === 'string' ? body.code : undefined) ??
    ''
  return /INTENT_VERSION_CONFLICT/i.test(code)
}

/** 冲突时服务端返回的当前记录（用于覆盖本地状态并提示已刷新）。 */
export function intentConflictFollowup(error: unknown): IntentFollowup | null {
  if (!isIntentVersionConflict(error)) return null
  const body = readRecord((error as ApiError).body)
  if (!body) return null
  const detail = readRecord(body.detail)
  const source = readRecord(detail?.current) ?? readRecord(body.current) ?? detail ?? body
  if (!source) return null
  const followup = readRecord(source.followup)
  if (followup) return mapIntentFollowupResponse(followup)
  if ('state' in source || 'version' in source) return mapIntentFollowupResponse(source)
  return null
}

/** 用户可读错误文案：优先后端 detail 文案，其次网络错误原文。 */
export function apiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return fallback
}
