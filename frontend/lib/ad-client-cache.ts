import type { Session } from 'next-auth'

import { clearClientCacheByPrefix, getClientCache, setClientCache } from '@/lib/client-cache'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { fetchWithTimeout } from '@/lib/fetch-with-timeout'

/**
 * BEL-421 广告板块页内数据懒加载：客户端响应缓存。
 *
 * 背景（为什么需要这层）：
 * - ad-analysis 10 个端点已有 30s 服务端 unstable_cache（见 lib/server/backend-cache.ts），
 *   但浏览器内的重复 mount（tab 来回切换、下钻返回、浏览器前进/后退）仍会发起真实
 *   HTTP 请求；这层把"2 分钟内的重复 mount"变成 0 网络请求。
 * - ad-data 的 ad-upload-files / ad-*-raw 两个端点不在任何缓存里，每次 mount 直连后端。
 *
 * 缓存键契约（最高风险——不要放宽）：
 *   后端按 X-Operator / 项目可见性过滤数据，且底层 client-cache 会写入 sessionStorage
 *   （跨整页刷新存活、同标签页换账号登录也不清空），因此键 MUST 携带用户身份
 *   （roleType/operator/userId）。此处泄漏 = 跨账号数据串号，P0。
 */

const AD_CACHE_PREFIX = 'ad:'
/** TTL 与 projects 缓存保持一致（2 分钟）：广告报表按上传批次更新，2 分钟陈旧可接受。 */
const AD_CACHE_TTL_MS = 2 * 60 * 1000
const AD_FETCH_TIMEOUT_MS = 15_000

/** 同一缓存键的在途请求去重：并发重复 mount 只产生一个网络请求。 */
const INFLIGHT = new Map<string, Promise<unknown>>()

type AdUser = {
  id?: string | null
  roleType?: string | null
  operatorNameZh?: string | null
}

function userScope(session?: Session | null): string {
  const user = (session?.user ?? {}) as AdUser
  const roleType = user.roleType ?? 'unknown'
  const operator = (user.operatorNameZh || '').trim() || 'none'
  const userId = (user.id || '').trim() || 'none'
  return `${roleType}:${operator}:${userId}`
}

/** 对 query 参数排序，保证参数顺序不同但语义相同的请求命中同一键。 */
export function normalizeAdCacheQuery(query: string): string {
  const stripped = query.startsWith('?') ? query.slice(1) : query
  if (!stripped) return ''
  const params = new URLSearchParams(stripped)
  return Array.from(params.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
}

async function parseError(response: Response, fallback: string): Promise<string> {
  const raw = await response.text()
  try {
    const payload = JSON.parse(raw) as { detail?: unknown; message?: unknown }
    if (typeof payload.detail === 'string' && payload.detail.trim()) return payload.detail
    if (typeof payload.message === 'string' && payload.message.trim()) return payload.message
  } catch {
    if (raw.trim()) return raw.trim()
  }
  return fallback
}

async function fetchAdJson<T>(url: string, session: Session | null | undefined, fallbackError: string): Promise<T> {
  const response = await fetchWithTimeout(url, {
    timeoutMs: AD_FETCH_TIMEOUT_MS,
    cache: 'no-store',
  })
  if (!response.ok) {
    const message = await parseError(response, fallbackError)
    throw new Error(normalizeErrorMessage(message, fallbackError))
  }
  return (await response.json()) as T
}

/**
 * 带缓存 + 在途去重的广告数据 GET。
 *
 * 注意：`session` 仅用于缓存键的用户域隔离（真实鉴权由 /api/backend 代理服务端注入），
 * 因此本模块不做任何 header 组装。
 */
export function fetchAdJsonCached<T>(
  url: string,
  options?: {
    session?: Session | null
    fallbackError?: string
    ttlMs?: number
  }
): Promise<T> {
  const fallbackError = options?.fallbackError || '广告数据加载失败'
  const key = `${AD_CACHE_PREFIX}${userScope(options?.session)}:${url}`
  const ttlMs = options?.ttlMs ?? AD_CACHE_TTL_MS

  const cached = getClientCache<T>(key, ttlMs)
  if (cached) return Promise.resolve(cached)

  const pending = INFLIGHT.get(key) as Promise<T> | undefined
  if (pending) return pending

  const request = (async () => {
    try {
      const payload = await fetchAdJson<T>(url, options?.session, fallbackError)
      setClientCache(key, payload)
      return payload
    } finally {
      INFLIGHT.delete(key)
    }
  })()

  INFLIGHT.set(key, request)
  return request
}

export function clearAdClientCaches(): void {
  clearClientCacheByPrefix(AD_CACHE_PREFIX)
}

// ── 面向页面的具名封装（收敛 URL 组装，避免散落在各 client）─────────────────

const API_BASE = '/api/backend'

export type AdAnalysisTabKey =
  | 'overview'
  | 'time-trend'
  | 'campaigns'
  | 'products'
  | 'search-terms'
  | 'targets'
  | 'placements'
  | 'budget'
  | 'traffic-quality'
  | 'purchased-products'

/** ad-analysis 10 个只读分析端点之一。query 形如 project_id=1&country=US&date_from=... */
export function fetchAdAnalysisCached<T>(
  tab: AdAnalysisTabKey,
  query: URLSearchParams | string,
  session?: Session | null
): Promise<T> {
  const search = normalizeAdCacheQuery(query instanceof URLSearchParams ? query.toString() : query)
  return fetchAdJsonCached<T>(`${API_BASE}/api/v1/ad-analysis/${tab}?${search}`, {
    session,
    fallbackError: '广告分析加载失败',
  })
}

/** ad-data：当前项目/国家下"哪些报表类型有成功入库数据"。
 * BLF-459 V3：/external/* 已下线，改走 /internal/ad-data（浏览器用户通道）。 */
export function fetchAdUploadFilesCached<T>(
  projectId: string,
  country: string,
  session?: Session | null
): Promise<T> {
  const search = normalizeAdCacheQuery(new URLSearchParams({ country }).toString())
  return fetchAdJsonCached<T>(
    `${API_BASE}/api/v1/internal/ad-data/projects/${projectId}/ad-upload-files?${search}`,
    { session, fallbackError: '广告报表列表加载失败' }
  )
}

/** ad-data：某个报表类型的原始行（limit 由调用方放在 query 中）。
 * BLF-459 V3：/external/* 已下线，改走 /internal/ad-data（浏览器用户通道）。 */
export function fetchAdRawCached<T>(
  projectId: string,
  endpoint: string,
  query: URLSearchParams | string,
  session?: Session | null
): Promise<T> {
  const search = normalizeAdCacheQuery(query instanceof URLSearchParams ? query.toString() : query)
  return fetchAdJsonCached<T>(
    `${API_BASE}/api/v1/internal/ad-data/projects/${projectId}/ad-${endpoint}-raw?${search}`,
    { session, fallbackError: '数据加载失败' }
  )
}
