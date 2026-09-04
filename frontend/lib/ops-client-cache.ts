import type { Session } from 'next-auth'

import { clearClientCacheByPrefix, getClientCache, setClientCache } from '@/lib/client-cache'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { fetchWithTimeout } from '@/lib/fetch-with-timeout'

/**
 * BEL-423 运营板块页内数据懒加载：客户端响应缓存。
 *
 * 背景（与 BEL-421 广告板块 ad-client-cache 同一思路）：
 * - 板块内的只读分析端点（daily-analysis / return-analysis / inventory-analysis /
 *   replenishment analysis / project-goals 等）在浏览器内的重复 mount（sidebar 来回、
 *   下钻返回、前进后退）仍会发起真实 HTTP 请求；这层把"2 分钟内的重复 mount"变成
 *   0 网络请求，直接降低后台数据库的重复查询压力。
 * - 仅收录"页面无写操作、或写操作后会主动清缓存"的端点；可变运营数据
 *   （船期列表/明细、巡检、店铺等）不入缓存。
 *
 * 缓存键契约（最高风险——不要放宽）：
 *   后端按 X-Operator / 项目可见性过滤数据，且底层 client-cache 会写入 sessionStorage
 *   （跨整页刷新存活、同标签页换账号登录也不清空），因此键 MUST 携带用户身份
 *   （roleType/operator/userId）。此处泄漏 = 跨账号数据串号，P0。
 */

const OPS_CACHE_PREFIX = 'ops:'
/** TTL 与 projects / 广告缓存保持一致（2 分钟）：分析类数据按上传批次更新，2 分钟陈旧可接受。 */
const OPS_CACHE_TTL_MS = 2 * 60 * 1000
const OPS_FETCH_TIMEOUT_MS = 20_000

/** 同一缓存键的在途请求去重：并发重复 mount 只产生一个网络请求。 */
const INFLIGHT = new Map<string, Promise<unknown>>()

type OpsUser = {
  id?: string | null
  roleType?: string | null
  operatorNameZh?: string | null
}

function userScope(session?: Session | null): string {
  const user = (session?.user ?? {}) as OpsUser
  const roleType = user.roleType ?? 'unknown'
  const operator = (user.operatorNameZh || '').trim() || 'none'
  const userId = (user.id || '').trim() || 'none'
  return `${roleType}:${operator}:${userId}`
}

/** 对 query 参数排序，保证参数顺序不同但语义相同的请求命中同一键。 */
export function normalizeOpsCacheQuery(query: string): string {
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

async function fetchOpsJson<T>(url: string, fallbackError: string): Promise<T> {
  const response = await fetchWithTimeout(url, {
    timeoutMs: OPS_FETCH_TIMEOUT_MS,
    cache: 'no-store',
  })
  if (!response.ok) {
    const message = await parseError(response, fallbackError)
    throw new Error(normalizeErrorMessage(message, fallbackError))
  }
  return (await response.json()) as T
}

/**
 * 带缓存 + 在途去重的板块数据 GET。
 *
 * - `force: true` 跳过缓存读取（显式"刷新"场景），成功后覆写缓存。
 * - `session` 仅用于缓存键的用户域隔离（真实鉴权由 /api/backend 代理服务端注入）。
 */
export function fetchOpsJsonCached<T>(
  url: string,
  options?: {
    session?: Session | null
    fallbackError?: string
    ttlMs?: number
    force?: boolean
  }
): Promise<T> {
  const fallbackError = options?.fallbackError || '数据加载失败'
  const key = `${OPS_CACHE_PREFIX}${userScope(options?.session)}:${url}`
  const ttlMs = options?.ttlMs ?? OPS_CACHE_TTL_MS

  if (!options?.force) {
    const cached = getClientCache<T>(key, ttlMs)
    if (cached) return Promise.resolve(cached)
  }

  const pending = INFLIGHT.get(key) as Promise<T> | undefined
  if (pending) return pending

  const request = (async () => {
    try {
      const payload = await fetchOpsJson<T>(url, fallbackError)
      setClientCache(key, payload)
      return payload
    } finally {
      INFLIGHT.delete(key)
    }
  })()

  INFLIGHT.set(key, request)
  return request
}

/**
 * 清空板块缓存。页内写操作（如目标设定的增删改）成功后调用，
 * 保证随后重载的进度/列表拿到最新数据。
 */
export function clearOpsClientCaches(): void {
  clearClientCacheByPrefix(OPS_CACHE_PREFIX)
}
