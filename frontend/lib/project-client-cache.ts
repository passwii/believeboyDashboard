import type { Session } from 'next-auth'

import { buildBackendClientHeaders } from '@/lib/backend-auth'
import { clearClientCacheByPrefix, getClientCache, setClientCache } from '@/lib/client-cache'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { fetchWithTimeout } from '@/lib/fetch-with-timeout'

const PROJECT_CACHE_PREFIX = 'projects:'
// TTL: 2 minutes — balances UX (avoid频繁刷新) vs权限变更感知
const PROJECTS_CACHE_TTL_MS = 2 * 60 * 1000

/**
 * 同一缓存键的在途请求去重（BEL-424）：并发重复 mount 只产生一个网络请求。
 * 与 ad-client-cache / ops-client-cache 同款语义 —— 例如 vat-invoice 页
 * SellerCard 与历史面板同时 mount 都取 projects/manage，冷启动只打一次后端。
 */
const INFLIGHT = new Map<string, Promise<unknown>>()

function normalizeScopePart(value: string | null | undefined): string {
  return (value || '').trim() || 'none'
}

function managedProjectsCacheKey(session?: Session | null, showInactive?: boolean): string {
  const roleType = session?.user?.roleType ?? 'unknown'
  const operatorName = normalizeScopePart(session?.user?.operatorNameZh)
  const userId = normalizeScopePart(session?.user?.id)
  return `${PROJECT_CACHE_PREFIX}manage:${roleType}:${operatorName}:${userId}:showInactive:${showInactive ?? false}`
}

async function parseError(response: Response, fallback: string): Promise<string> {
  const raw = await response.text()
  const text = raw.trim()

  try {
    const payload = JSON.parse(raw) as { detail?: unknown; message?: unknown }
    if (typeof payload.detail === 'string' && payload.detail.trim()) return payload.detail
    if (typeof payload.message === 'string' && payload.message.trim()) return payload.message
  } catch {
    if (text.trim()) return text
  }
  return fallback
}

async function fetchCachedJson<T>(
  key: string,
  url: string,
  options?: {
    session?: Session | null
    fallbackError?: string
    force?: boolean
  }
): Promise<T> {
  if (!options?.force) {
    const cached = getClientCache<T>(key, PROJECTS_CACHE_TTL_MS)
    if (cached) return cached
  }

  const pending = INFLIGHT.get(key) as Promise<T> | undefined
  if (pending) return pending

  const request = (async () => {
    try {
      const response = await fetchWithTimeout(url, {
        timeoutMs: 5_000,
        cache: 'no-store',
        headers: buildBackendClientHeaders(options?.session ?? null),
      })
      if (!response.ok) {
        const message = await parseError(
          response,
          options?.fallbackError || `请求失败 (${response.status})`
        )
        throw new Error(normalizeErrorMessage(message, options?.fallbackError || '加载失败'))
      }

      const payload = (await response.json()) as T
      setClientCache(key, payload)
      return payload
    } finally {
      INFLIGHT.delete(key)
    }
  })()

  INFLIGHT.set(key, request)
  return request
}

export function clearProjectClientCaches(): void {
  clearClientCacheByPrefix(PROJECT_CACHE_PREFIX)
}

export async function fetchProjectOptionsCached<T>(): Promise<T> {
  return fetchCachedJson<T>(`${PROJECT_CACHE_PREFIX}options`, '/api/backend/api/v1/projects', {
    fallbackError: '项目列表加载失败',
  })
}

export async function fetchManagedProjectsCached<T>(
  session?: Session | null,
  showInactive?: boolean,
  options?: { force?: boolean }
): Promise<T> {
  const baseUrl = showInactive
    ? '/api/backend/api/v1/projects/manage?show_inactive=true'
    : '/api/backend/api/v1/projects/manage'
  const url = options?.force
    ? `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}_cache_bust=${Date.now()}`
    : baseUrl
  return fetchCachedJson<T>(managedProjectsCacheKey(session, showInactive), url, {
    session,
    fallbackError: '项目列表加载失败',
    force: options?.force,
  })
}

export async function fetchProjectOperatorOptionsCached(): Promise<string[]> {
  return fetchCachedJson<string[]>(
    `${PROJECT_CACHE_PREFIX}operator-options`,
    '/api/backend/api/v1/projects/operator-options',
    { fallbackError: '操作员列表加载失败' }
  )
}
