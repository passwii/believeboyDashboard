// ── 定时报告共享 API 调用和辅助函数 ──
import { normalizeErrorMessage } from '@/lib/error-utils'
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
  projects: Array<{ id?: number | null; name: string }>,
): string[] {
  if (projectIds === '*') return ['全部项目']
  const ids = projectIds.split(',').map(id => id.trim()).filter(Boolean)
  return ids
    .map(id => {
      const idNum = parseInt(id, 10)
      const found = projects.find(p => p.id === idNum)
      return found ? found.name : `项目${id}`
    })
    .filter(name => name)
}

/** 格式化项目名称列表为截断显示 */
export function formatProjectNames(
  projectNames: string[],
  maxNames: number = 2,
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

// ── 模型配置 ──

export async function fetchModelConfig(
  onConfig: (cfg: AIModelConfig) => void,
  onDefaultModel?: (model: string) => void,
): Promise<AIModelConfig | null> {
  try {
    const res = await fetch('/api/ai-chat/config', {
      method: 'GET',
      cache: 'no-store',
    })
    const payload = (await res.json()) as AIModelConfig
    if (res.ok) {
      onConfig(payload)
      onDefaultModel?.(payload.defaultModel || '')
      return payload
    }
    return null
  } catch (e) {
    console.error('Failed to load AI model config', e)
    return null
  }
}

// ── 订阅 CRUD ──

export async function fetchSubscriptions(
  session: unknown,
  onData: (subs: Subscription[], projects: Array<{ id?: number | null; name: string }>) => void,
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
      projectData.filter((p: { name: string }) => typeof p.name === 'string' && p.name.trim()),
    )
  } catch (e) {
    console.error(e)
  }
}

export async function createSubscription(
  data: {
    email: string
    project_ids: string
    country: string
    frequency: Frequency
    dispatch_hour: number
    dispatch_minute: number
    dispatch_weekday: number | null
    dispatch_day: number | null
    ai_model: string | null
  },
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(resolveApiUrl('/api/v1/scheduled-reports/subscriptions'), {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!res.ok) {
      const err = await res.text()
      return { ok: false, error: err || '创建失败' }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: normalizeErrorMessage(e, '创建失败') }
  }
}

export async function updateSubscription(
  id: number,
  data: {
    email: string
    project_ids: string
    country: string
    frequency: Frequency
    dispatch_hour: number
    dispatch_minute: number
    dispatch_weekday: number | null
    dispatch_day: number | null
    ai_model: string | null
  },
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(resolveApiUrl(`/api/v1/scheduled-reports/subscriptions/${id}`), {
      method: 'PUT',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!res.ok) {
      const err = await res.text()
      return { ok: false, error: err || '更新失败' }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: normalizeErrorMessage(e, '更新失败') }
  }
}

export async function deleteSubscription(
  id: number,
): Promise<boolean> {
  try {
    const res = await fetch(resolveApiUrl(`/api/v1/scheduled-reports/subscriptions/${id}`), {
      method: 'DELETE',
      headers: authHeaders(),
    })
    return res.ok
  } catch (e) {
    console.error(e)
    return false
  }
}

export async function toggleSubscription(
  id: number,
  enabled: boolean,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(resolveApiUrl(`/api/v1/scheduled-reports/subscriptions/${id}`), {
      method: 'PUT',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    })
    return { ok: res.ok }
  } catch (e) {
    return { ok: false, error: normalizeErrorMessage(e, '操作失败') }
  }
}

// ── 测试邮件 ──

export async function sendTestEmail(
  data: {
    email: string
    frequency: Frequency
    project_ids: string
    country: string
    ai_model: string | null
  },
): Promise<{ success: boolean; message: string }> {
  try {
    const res = await fetch(resolveApiUrl('/api/v1/scheduled-reports/test-email'), {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    const json = await res.json()
    return { success: json.success, message: json.message }
  } catch (e) {
    return { success: false, message: normalizeErrorMessage(e, '发送失败') }
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
    limit?: number
  },
  onData: (items: LedgerItem[], summary: LedgerSummary | null) => void,
  onError: (error: string) => void,
) {
  const q = new URLSearchParams({
    start_date: params.startDate,
    end_date: params.endDate,
    frequency: params.frequency,
    status_filter: params.statusFilter,
    limit: String(params.limit ?? 100),
  })
  if (params.email.trim()) q.set('email', params.email.trim())
  try {
    const res = await fetch(resolveApiUrl(`/api/v1/scheduled-reports/ledger?${q.toString()}`), {
      headers: authHeaders(),
    })
    if (!res.ok) throw new Error(await res.text())
    const data = (await res.json()) as { items: LedgerItem[]; summary: LedgerSummary }
    onData(data.items || [], data.summary || null)
  } catch (e) {
    onError(normalizeErrorMessage(e, '加载台账失败'))
  }
}

export async function fetchLedgerItemByKey(
  sourceItem: LedgerItem,
): Promise<LedgerItem | null> {
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
      found = items.find(item => item.ledger_key === sourceItem.ledger_key) ?? null
    },
    () => {},
  )
  return found
}

export async function resendLedgerEntry(
  ledgerKey: string,
  isAdmin: boolean,
  overrideAiModel?: string | null,
): Promise<{ ok: boolean; deliveryLogId?: number; error?: string }> {
  const params = new URLSearchParams()
  if (isAdmin) params.set('force', 'true')
  if (overrideAiModel?.trim()) params.set('ai_model', overrideAiModel.trim())
  const qs = params.toString()
  const url = qs
    ? resolveApiUrl(`/api/v1/scheduled-reports/ledger/${encodeURIComponent(ledgerKey)}/resend?${qs}`)
    : resolveApiUrl(`/api/v1/scheduled-reports/ledger/${encodeURIComponent(ledgerKey)}/resend`)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: authHeadersWithAdmin(),
    })
    if (!res.ok) throw new Error(await res.text())
    const data = await res.json()
    return { ok: true, deliveryLogId: data.delivery_log_id }
  } catch (e) {
    return { ok: false, error: normalizeErrorMessage(e) }
  }
}

export async function regenerateLedgerAiSummary(
  ledgerKey: string,
  overrideAiModel?: string | null,
): Promise<{ ok: boolean; deliveryLogId?: number; status?: string; error?: string }> {
  const params = new URLSearchParams()
  if (overrideAiModel?.trim()) params.set('ai_model', overrideAiModel.trim())
  const qs = params.toString()
  const url = qs
    ? resolveApiUrl(`/api/v1/scheduled-reports/ledger/${encodeURIComponent(ledgerKey)}/ai-summary/regenerate?${qs}`)
    : resolveApiUrl(`/api/v1/scheduled-reports/ledger/${encodeURIComponent(ledgerKey)}/ai-summary/regenerate`)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: authHeadersWithAdmin(),
    })
    if (!res.ok) throw new Error(await res.text())
    const data = await res.json()
    return { ok: true, deliveryLogId: data.delivery_log_id, status: data.status }
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
  pollInterval = 2500,
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
  onError: (key: string) => void,
  pollInterval = 2000,
) {
  const poll = async () => {
    try {
      const res = await fetch(
        resolveApiUrl('/api/v1/scheduled-reports/delivery-logs?limit=1'),
        { headers: authHeaders() },
      )
      if (!res.ok) {
        setTimeout(poll, pollInterval * 2)
        return
      }
      const data = await res.json()
      const log = data.items?.find((l: { id: number }) => l.id === deliveryLogId)
      if (!log) {
        setTimeout(poll, pollInterval)
        return
      }
      const stage = log.stage as string
      onStage(ledgerKey, stage)
      if (stage === 'done' || stage === 'failed') {
        onDone(ledgerKey)
        return
      }
      setTimeout(poll, pollInterval)
    } catch {
      setTimeout(poll, pollInterval * 2)
    }
  }
  poll()
}
