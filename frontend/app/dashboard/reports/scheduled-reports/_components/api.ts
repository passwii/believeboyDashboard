// ── 定时报告共享 API 调用和辅助函数 ──
import { ensureConfigLoaded } from '@/lib/api/ai-chat-config-store'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { readInsightRunId } from './ledger-insight'
import type { AIModelConfig, Frequency, LedgerItem, LedgerSummary, Subscription } from './types'

const API_BASE = '/api/backend'

export function authHeaders(): Record<string, string> {
  return {}
}

export function authHeadersWithAdmin(): Record<string, string> {
  return { 'X-Is-Admin': 'true' }
}

export function resolveApiUrl(path: string) {
  const base = API_BASE.endsWith('/') ? API_BASE.slice(0, -1) : API_BASE
  if (!path.startsWith('/')) return `${base}/${path}`
  return `${base}${path}`
}

/** 将 project_ids 字符串转换为项目名称列表 */
export function resolveProjectNames(
  projectIds: string,
  projects: Array<{ id?: number | null; name: string }>
): string[] {
  if (projectIds === '*') return ['全部项目']
  const ids = projectIds
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
  return ids
    .map((id) => {
      const idNum = parseInt(id, 10)
      const found = projects.find((p) => p.id === idNum)
      return found ? found.name : `项目${id}`
    })
    .filter((name) => name)
}

/** 格式化项目名称列表为截断显示 */
export function formatProjectNames(
  projectNames: string[],
  maxNames: number = 2
): { display: string; full: string } {
  if (projectNames.length === 0) return { display: '全部项目', full: '全部项目' }
  if (projectNames.length <= maxNames) {
    return { display: projectNames.join(', '), full: projectNames.join(', ') }
  }
  const shown = projectNames.slice(0, maxNames)
  const hidden = projectNames.length - maxNames
  return {
    display: `${shown.join(', ')} +${hidden}`,
    full: projectNames.join(', '),
  }
}

// ── 错误响应解析 ──
// Go 后端错误体统一是 FastAPI 形状：`{"detail": "..."}`；网关参数校验可能是
// `{"detail": [{loc, msg, type}]}`；Next 代理自身失败则是 `{"message": "..."}`。
// 这里一次性收敛：既不让 `{"detail":...}` 原样出现在用户文案里，也把后端已知的
// 英文错误翻成中文可操作提示。未知英文/HTML 只回落到状态级中文兜底。

const CHINESE_TEXT = /[\u4e00-\u9fff]/

const API_ERROR_MESSAGES: Record<string, string> = {
  'email is required': '请填写邮箱地址后再发送测试邮件',
  'invalid request body': '请求参数无效，请检查后重试',
  'scheduled report store not configured': '定时报告服务未配置，请联系管理员',
  'test report mailer not configured': '测试邮件服务未配置，请联系管理员',
  'scheduled report enqueuer not configured': '定时报告任务队列未配置，请联系管理员',
  'scheduled report queue unavailable': '定时报告任务队列暂不可用，请稍后重试',
  'ledger entry not found': '台账记录不存在，请刷新台账后重试',
  'ledger entry already sent': '该记录已发送成功，无需重新生成',
  'delivery log missing': '该记录没有可用的发送日志，无法重新生成',
  'delivery not sent': '该记录尚未发送成功，无法生成 AI 摘要',
  'subscription not found': '订阅不存在，请刷新订阅列表后重试',
  'ledger_key is required': '台账记录标识缺失，请刷新后重试',
  unauthorized: '登录状态已失效，请重新登录后重试',
  'not authenticated': '登录状态已失效，请重新登录后重试',
  'internal server error': '服务暂时不可用，请稍后重试',
  'start_date and end_date are required': '请选择完整的台账日期范围',
  'start_date must be yyyy-mm-dd': '开始日期格式无效，请重新选择',
  'end_date must be yyyy-mm-dd': '结束日期格式无效，请重新选择',
  'end_date must be greater than or equal to start_date': '结束日期不能早于开始日期',
  'project_id must be a valid integer': '项目筛选值无效，请重新选择',
  'project_id must be greater than 0': '项目筛选值无效，请重新选择',
}

const API_ERROR_PATTERNS: Array<[RegExp, string]> = [
  [/^field required$/i, '必填项缺失，请检查后重试'],
  [/^value is not a valid email address/i, '邮箱格式无效，请输入完整邮箱地址'],
  [/^value is not a valid/i, '参数格式无效，请检查后重试'],
  [/^invalid email/i, '邮箱格式无效，请输入完整邮箱地址'],
]

function detailText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) {
    return value.map(detailText).filter(Boolean).join('；')
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return detailText(record.msg ?? record.message ?? record.detail ?? record.error)
  }
  return ''
}

function statusFallback(status: number, fallback: string): string {
  if (status === 401 || status === 403) return '登录状态已失效或无权限，请刷新页面后重试'
  if (status === 404) return '记录不存在或已被删除，请刷新后重试'
  if (status === 409) return '当前状态不允许该操作，请刷新后重试'
  if (status === 422) return '请求参数无效，请检查后重试'
  if (status === 429) return '操作过于频繁，请稍后重试'
  if (status >= 500) return '服务暂时不可用，请稍后重试'
  return fallback
}

function translateSingleMessage(message: string): string {
  const trimmed = message.trim()
  if (!trimmed) return ''
  const mapped = API_ERROR_MESSAGES[trimmed.toLowerCase()]
  if (mapped) return mapped
  for (const [pattern, replacement] of API_ERROR_PATTERNS) {
    if (pattern.test(trimmed)) return replacement
  }
  // 后端大量校验文案本身是中文（项目 / 邮箱 / 频率等），原样保留即可。
  if (CHINESE_TEXT.test(trimmed)) return trimmed
  return ''
}

function translateApiMessage(message: string, status: number, fallback: string): string {
  const trimmed = message.trim()
  if (!trimmed) return statusFallback(status, fallback)
  // FastAPI 校验错误会一次返回多项 detail；逐项翻译后保留分号分隔，
  // 避免整串英文命中不了映射表被当成未知错误。
  const parts = trimmed
    .split('；')
    .map(translateSingleMessage)
    .filter(Boolean)
  if (parts.length > 0) return parts.join('；')
  // 未知英文细节不直接暴露给用户，回落到按状态给出的中文兜底。
  return statusFallback(status, fallback)
}

/**
 * 从任意 HTTP 错误响应体提取可读文案。导出便于对错误体形状做纯函数测试。
 * 支持 `detail` 字符串、`detail` 数组（FastAPI 校验）、`message` / `error`，
 * 以及非 JSON 的纯文本 / HTML（HTML 不原样透出）。
 */
export function parseApiErrorText(raw: string, status: number, fallback: string): string {
  const text = raw.trim()
  if (!text) return statusFallback(status, fallback)
  if (/<html|<body|<!doctype/i.test(text)) return statusFallback(status, fallback)

  try {
    const payload = JSON.parse(text) as Record<string, unknown>
    const detail = detailText(payload.detail ?? payload.message ?? payload.error)
    return translateApiMessage(detail || text, status, fallback)
  } catch {
    return translateApiMessage(text, status, fallback)
  }
}

async function readApiError(response: Response, fallback: string): Promise<string> {
  let raw = ''
  try {
    raw = await response.text()
  } catch {
    return statusFallback(response.status, fallback)
  }
  return parseApiErrorText(raw, response.status, fallback)
}

// ── 模型配置 ──

export async function fetchModelConfig(
  onConfig: (cfg: AIModelConfig) => void,
  onDefaultModel?: (model: string) => void
): Promise<AIModelConfig | null> {
  try {
    // BEL-424：改走 ai-chat 配置 store（模块级缓存 + 在途去重）——
    // AI 聊天 / 客服 / AI 洞察 / 定时报告共享同一份配置，跨页不重复请求。
    const config = await ensureConfigLoaded()
    const payload: AIModelConfig = {
      providerConfigured: config.providerConfigured,
      models: config.models,
      defaultModel: config.defaultModel,
      premiumModels: config.premiumModels,
      basicModels: config.basicModels,
    }
    onConfig(payload)
    onDefaultModel?.(payload.defaultModel || '')
    return payload
  } catch (e) {
    console.error('Failed to load AI model config', e)
    return null
  }
}

// ── 订阅 CRUD ──

export async function fetchSubscriptions(
  session: unknown,
  onData: (subs: Subscription[], projects: Array<{ id?: number | null; name: string }>) => void
) {
  const { fetchManagedProjectsCached } = await import('@/lib/project-client-cache')
  try {
    const [subRes, projectData] = await Promise.all([
      fetch(resolveApiUrl('/api/v1/scheduled-reports/subscriptions'), {
        headers: authHeaders(),
      }),
      fetchManagedProjectsCached<Array<{ id?: number | null; name: string }>>(session as any),
    ])
    const subs = subRes.ok ? await subRes.json() : { items: [] }
    onData(
      subs.items || [],
      projectData.filter((p: { name: string }) => typeof p.name === 'string' && p.name.trim())
    )
  } catch (e) {
    console.error(e)
  }
}

export async function createSubscription(data: {
  email: string | null
  project_ids: string
  country: string
  frequency: Frequency
  dispatch_hour: number
  dispatch_minute: number
  dispatch_weekday: number | null
  dispatch_day: number | null
  ai_model: string | null
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(resolveApiUrl('/api/v1/scheduled-reports/subscriptions'), {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!res.ok) {
      return { ok: false, error: await readApiError(res, '创建失败，请稍后重试') }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: normalizeErrorMessage(e, '创建失败') }
  }
}

export async function updateSubscription(
  id: number,
  data: {
    email: string | null
    project_ids: string
    country: string
    frequency: Frequency
    dispatch_hour: number
    dispatch_minute: number
    dispatch_weekday: number | null
    dispatch_day: number | null
    ai_model: string | null
  }
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(resolveApiUrl(`/api/v1/scheduled-reports/subscriptions/${id}`), {
      method: 'PUT',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!res.ok) {
      return { ok: false, error: await readApiError(res, '更新失败，请稍后重试') }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: normalizeErrorMessage(e, '更新失败') }
  }
}

export async function deleteSubscription(
  id: number
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(resolveApiUrl(`/api/v1/scheduled-reports/subscriptions/${id}`), {
      method: 'DELETE',
      headers: authHeaders(),
    })
    if (!res.ok) {
      return { ok: false, error: await readApiError(res, '删除失败，请稍后重试') }
    }
    return { ok: true }
  } catch (e) {
    console.error(e)
    return { ok: false, error: normalizeErrorMessage(e, '删除失败，请稍后重试') }
  }
}

/**
 * 订阅可局部更新的字段。后端 `SubscriptionUpdate` 全字段可选，
 * 未提供的字段保持原值 —— 因此批量操作只发要改的那一个字段，
 * 不会把并发编辑中的其它字段回写覆盖。
 */
export type SubscriptionPatch = Partial<{
  email: string | null
  project_ids: string
  country: string
  frequency: Frequency
  dispatch_hour: number
  dispatch_minute: number
  dispatch_weekday: number | null
  dispatch_day: number | null
  ai_model: string | null
  enabled: boolean
}>

async function patchSubscription(
  id: number,
  patch: SubscriptionPatch,
  fallbackError = '操作失败'
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(resolveApiUrl(`/api/v1/scheduled-reports/subscriptions/${id}`), {
      method: 'PUT',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (!res.ok) {
      return { ok: false, error: await readApiError(res, fallbackError) }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: normalizeErrorMessage(e, fallbackError) }
  }
}

export async function toggleSubscription(
  id: number,
  enabled: boolean
): Promise<{ ok: boolean; error?: string }> {
  return patchSubscription(id, { enabled })
}

/** 批量操作的汇总结果：成功 id 列表 + 每条失败的首个错误文案 */
export interface BatchResult {
  okIds: number[]
  failed: { id: number; error: string }[]
}

function summarizeBatch(
  ids: number[],
  results: PromiseSettledResult<{ ok: boolean; error?: string }>[],
  fallbackError: string
): BatchResult {
  const okIds: number[] = []
  const failed: { id: number; error: string }[] = []
  results.forEach((result, i) => {
    const id = ids[i]!
    if (result.status === 'fulfilled' && result.value.ok) okIds.push(id)
    else if (result.status === 'fulfilled')
      failed.push({ id, error: result.value.error || fallbackError })
    else failed.push({ id, error: normalizeErrorMessage(result.reason, fallbackError) })
  })
  return { okIds, failed }
}

/**
 * 批量局部更新（BLF-1032）：逐条并发 PUT，单条失败不拖垮其余（allSettled 语义），
 * 由调用方按 `failed.length` 决定提示强度。订阅量级为几十条，无需后端 batch 端点。
 */
export async function batchPatchSubscriptions(
  ids: number[],
  patch: SubscriptionPatch
): Promise<BatchResult> {
  const results = await Promise.allSettled(ids.map((id) => patchSubscription(id, patch, '更新失败')))
  return summarizeBatch(ids, results, '更新失败')
}

/** 批量删除：DELETE 只返回成功与否，失败按条数汇总，不细化文案 */
export async function batchDeleteSubscriptions(ids: number[]): Promise<BatchResult> {
  const results = await Promise.allSettled(ids.map((id) => deleteSubscription(id)))
  return summarizeBatch(ids, results, '删除失败')
}

// ── 测试邮件 ──

export async function sendTestEmail(data: {
  email: string
  frequency: Frequency
  project_ids: string
  country: string
  ai_model: string | null
}): Promise<{ success: boolean; message: string }> {
  try {
    const res = await fetch(resolveApiUrl('/api/v1/scheduled-reports/test-email'), {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    // 非 2xx 绝不能静默：后端 422（email is required）/ 409 / 500 都带 detail，
    // 统一解析成中文可操作提示；HTML 错误页不回显。
    if (!res.ok) {
      return { success: false, message: await readApiError(res, '测试邮件发送失败，请稍后重试') }
    }
    let json: { success?: unknown; message?: unknown }
    try {
      json = (await res.json()) as { success?: unknown; message?: unknown }
    } catch {
      return { success: false, message: '测试邮件服务返回异常，请稍后重试' }
    }
    const message =
      typeof json.message === 'string' && json.message.trim()
        ? json.message.trim()
        : ''
    if (json.success === true) {
      return { success: true, message: message || '测试邮件已发送' }
    }
    return {
      success: false,
      message: translateApiMessage(message, res.status, '测试邮件发送失败，请稍后重试'),
    }
  } catch (e) {
    return { success: false, message: normalizeErrorMessage(e, '测试邮件发送失败，请稍后重试') }
  }
}

// ── 台账 ──

export async function fetchLedger(
  params: {
    startDate: string
    endDate: string
    frequency: string
    statusFilter: string
    email: string
    /** 后端 project_id 过滤：项目字符串匹配（含 * 与多项目交集语义）。 */
    projectId?: string
    limit?: number
  },
  onData: (items: LedgerItem[], summary: LedgerSummary | null, total?: number) => void,
  onError: (error: string) => void
) {
  const q = new URLSearchParams({
    start_date: params.startDate,
    end_date: params.endDate,
    frequency: params.frequency,
    status_filter: params.statusFilter,
    limit: String(params.limit ?? 100),
  })
  if (params.email.trim()) q.set('email', params.email.trim())
  if (params.projectId?.trim()) q.set('project_id', params.projectId.trim())
  try {
    const res = await fetch(resolveApiUrl(`/api/v1/scheduled-reports/ledger?${q.toString()}`), {
      headers: authHeaders(),
    })
    if (!res.ok) throw new Error(await readApiError(res, '加载台账失败，请稍后重试'))
    let data: { items: LedgerItem[]; summary: LedgerSummary; total?: number }
    try {
      data = (await res.json()) as {
        items: LedgerItem[]
        summary: LedgerSummary
        total?: number
      }
    } catch {
      onError('台账响应格式异常，请稍后重试')
      return
    }
    const items: LedgerItem[] = Array.isArray(data.items)
      ? data.items.map(withInsightRunBinding)
      : []
    onData(items, data.summary || null, data.total ?? items.length)
  } catch (e) {
    onError(normalizeErrorMessage(e, '加载台账失败，请稍后重试'))
  }
}

/**
 * 把后端回填的 insight run 绑定收敛到 `insight_run_id` 一个字段上（BLF-1015），
 * 后端用哪个字段名回填都能认。其余字段保持原样。
 */
function withInsightRunBinding(item: LedgerItem): LedgerItem {
  const runId = readInsightRunId(item)
  return runId ? { ...item, insight_run_id: runId } : item
}

export async function fetchLedgerItemByKey(sourceItem: LedgerItem): Promise<LedgerItem | null> {
  let found: LedgerItem | null = null
  await fetchLedger(
    {
      startDate: sourceItem.expected_date,
      endDate: sourceItem.expected_date,
      frequency: sourceItem.frequency,
      statusFilter: 'all',
      email: '',
      limit: 100,
    },
    (items) => {
      found = items.find((item) => item.ledger_key === sourceItem.ledger_key) ?? null
    },
    () => {}
  )
  return found
}

export async function resendLedgerEntry(
  ledgerKey: string,
  isAdmin: boolean,
  overrideAiModel?: string | null
): Promise<{ ok: boolean; deliveryLogId?: number; error?: string }> {
  const params = new URLSearchParams()
  if (isAdmin) params.set('force', 'true')
  if (overrideAiModel?.trim()) params.set('ai_model', overrideAiModel.trim())
  const qs = params.toString()
  const url = qs
    ? resolveApiUrl(
        `/api/v1/scheduled-reports/ledger/${encodeURIComponent(ledgerKey)}/resend?${qs}`
      )
    : resolveApiUrl(`/api/v1/scheduled-reports/ledger/${encodeURIComponent(ledgerKey)}/resend`)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: authHeadersWithAdmin(),
    })
    if (!res.ok) throw new Error(await readApiError(res, '重新生成失败，请稍后重试'))
    const data = await res.json()
    return { ok: true, deliveryLogId: data.delivery_log_id }
  } catch (e) {
    return { ok: false, error: normalizeErrorMessage(e, '重新生成失败，请稍后重试') }
  }
}

export async function regenerateLedgerAiSummary(
  ledgerKey: string,
  overrideAiModel?: string | null
): Promise<{ ok: boolean; deliveryLogId?: number; status?: string; runId?: string; error?: string }> {
  const params = new URLSearchParams()
  if (overrideAiModel?.trim()) params.set('ai_model', overrideAiModel.trim())
  const qs = params.toString()
  const url = qs
    ? resolveApiUrl(
        `/api/v1/scheduled-reports/ledger/${encodeURIComponent(ledgerKey)}/ai-summary/regenerate?${qs}`
      )
    : resolveApiUrl(
        `/api/v1/scheduled-reports/ledger/${encodeURIComponent(ledgerKey)}/ai-summary/regenerate`
      )
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: authHeadersWithAdmin(),
    })
    if (!res.ok) throw new Error(await readApiError(res, 'AI 摘要生成失败，请稍后重试'))
    const data = await res.json()
    return {
      ok: true,
      deliveryLogId: data.delivery_log_id,
      status: data.status,
      runId: readInsightRunId(data) ?? undefined,
    }
  } catch (e) {
    return { ok: false, error: normalizeErrorMessage(e) }
  }
}

export async function pollLedgerAiSummaryStatus(
  ledgerKey: string,
  fetchItem: () => Promise<LedgerItem | null>,
  onItem: (item: LedgerItem) => void,
  onDone: (item: LedgerItem) => void,
  onError: (item: LedgerItem | null) => void,
  pollInterval = 2500
) {
  const poll = async () => {
    try {
      const item = await fetchItem()
      if (!item) {
        setTimeout(poll, pollInterval)
        return
      }
      onItem(item)
      if (item.ai_summary_status === 'done') {
        onDone(item)
        return
      }
      if (item.ai_summary_status === 'failed') {
        onError(item)
        return
      }
      setTimeout(poll, pollInterval)
    } catch {
      setTimeout(poll, pollInterval * 2)
    }
  }
  poll()
}

export async function pollDeliveryLogStatus(
  ledgerKey: string,
  deliveryLogId: number,
  onStage: (key: string, stage: string) => void,
  onDone: (key: string) => void,
  onError: (key: string, reason: 'failed' | 'timeout') => void,
  pollInterval = 2000,
  /** 同一 stage 持续多久后停止轮询并提示用户（毫秒） */
  stallTimeoutMs = 120000
) {
  let lastStage: string | null = null
  let lastStageChangedAt = Date.now()

  const poll = async () => {
    try {
      // 旧实现只取 limit=1，别的 delivery log（例如同用户其它订阅）排在前面时
      // 目标 id 永远找不到，前端就会无声地停在「准备中」。取最近 50 条足够覆盖
      // 并发窗口，同时保留按 delivery_log_id 精确匹配。
      const res = await fetch(
        resolveApiUrl('/api/v1/scheduled-reports/delivery-logs?limit=50'),
        { headers: authHeaders() }
      )
      if (!res.ok) {
        setTimeout(poll, pollInterval * 2)
        return
      }
      const data = (await res.json()) as { items?: Array<{ id: number; stage?: string }> }
      const log = data.items?.find((l) => l.id === deliveryLogId)
      if (!log) {
        setTimeout(poll, pollInterval)
        return
      }
      const stage = log.stage ?? 'preparing'
      if (stage !== lastStage) {
        lastStage = stage
        lastStageChangedAt = Date.now()
      }
      onStage(ledgerKey, stage)
      if (stage === 'done') {
        onDone(ledgerKey)
        return
      }
      if (stage === 'failed') {
        onError(ledgerKey, 'failed')
        return
      }
      if (Date.now() - lastStageChangedAt >= stallTimeoutMs) {
        onError(ledgerKey, 'timeout')
        return
      }
      setTimeout(poll, pollInterval)
    } catch {
      setTimeout(poll, pollInterval * 2)
    }
  }
  poll()
}
