import { normalizeErrorMessage } from '@/lib/error-utils'

type BackendErrorPayload = { detail?: string; message?: string }

function trimTrailingSlash(value: string) {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

export function getBackendBaseUrl() {
  const base = process.env.BACKEND_API_BASE_URL || 'http://127.0.0.1:8100'
  return trimTrailingSlash(base)
}

export function getBackendApiKey() {
  return process.env.BACKEND_API_KEY || ''
}

/**
 * Append `?api_key=<key>` (or `&api_key=...`) to a backend path.
 *
 * Vercel/edge server-to-server `fetch()` strips auth headers (both custom
 * `X-API-Key` and standard `Authorization`), so the only thing guaranteed to
 * survive is a URL query parameter. The backend `require_api_key` accepts
 * `?api_key=` as the last-resort fallback (added 2026-07-22, live-chat 401
 * round 2). Returns the path unchanged when the env key is unset.
 */
export function appendApiKeyQuery(path: string): string {
  const apiKey = getBackendApiKey()
  if (!apiKey) return path
  const sep = path.includes('?') ? '&' : '?'
  return `${path}${sep}api_key=${encodeURIComponent(apiKey)}`
}

export async function backendFetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${getBackendBaseUrl()}${appendApiKeyQuery(path)}`, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(5_000),
  })
  const data = (await response.json()) as T & BackendErrorPayload
  if (!response.ok) {
    throw new Error(normalizeErrorMessage(data.message || data.detail, '请求后端失败'))
  }
  return data
}
