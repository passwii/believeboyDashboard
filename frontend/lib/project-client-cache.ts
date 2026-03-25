import type { Session } from 'next-auth'

import { buildBackendHeaders } from '@/lib/backend-auth'
import { clearClientCacheByPrefix, getClientCache, setClientCache } from '@/lib/client-cache'

const PROJECT_CACHE_PREFIX = 'projects:'
const PROJECTS_CACHE_TTL_MS = 10 * 60 * 1000

function normalizeScopePart(value: string | null | undefined): string {
  return (value || '').trim() || 'none'
}

function managedProjectsCacheKey(session?: Session | null): string {
  const isAdmin = Boolean(session?.user?.isAdmin)
  const operatorName = normalizeScopePart(session?.user?.operatorNameZh)
  const userId = normalizeScopePart(session?.user?.id)
  return `${PROJECT_CACHE_PREFIX}manage:${isAdmin ? 'admin' : 'member'}:${operatorName}:${userId}`
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
  }
): Promise<T> {
  const cached = getClientCache<T>(key, PROJECTS_CACHE_TTL_MS)
  if (cached) return cached

  const response = await fetch(url, {
    cache: 'no-store',
    headers: buildBackendHeaders(options?.session),
  })
  if (!response.ok) {
    throw new Error(await parseError(response, options?.fallbackError || `请求失败 (${response.status})`))
  }

  const payload = (await response.json()) as T
  setClientCache(key, payload)
  return payload
}

export function clearProjectClientCaches(): void {
  clearClientCacheByPrefix(PROJECT_CACHE_PREFIX)
}

export async function fetchProjectOptionsCached<T>(): Promise<T> {
  return fetchCachedJson<T>(
    `${PROJECT_CACHE_PREFIX}options`,
    '/api/backend/api/v1/projects',
    { fallbackError: '项目列表加载失败' }
  )
}

export async function fetchManagedProjectsCached<T>(session?: Session | null): Promise<T> {
  return fetchCachedJson<T>(
    managedProjectsCacheKey(session),
    '/api/backend/api/v1/projects/manage',
    { session, fallbackError: '项目列表加载失败' }
  )
}

export async function fetchProjectOperatorOptionsCached(): Promise<string[]> {
  return fetchCachedJson<string[]>(
    `${PROJECT_CACHE_PREFIX}operator-options`,
    '/api/backend/api/v1/projects/operator-options',
    { fallbackError: '操作员列表加载失败' }
  )
}
