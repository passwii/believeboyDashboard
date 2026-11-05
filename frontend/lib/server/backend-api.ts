import { normalizeErrorMessage } from '@/lib/error-utils'

type BackendErrorPayload = {
  detail?: unknown
  message?: unknown
  /** 后端稳定错误码枚举（如 `LOGIN_INVALID_CREDENTIALS`），只增不改。 */
  code?: unknown
  /** 本次请求的追踪 ID，与响应头 `X-Request-Id` 同值。 */
  request_id?: unknown
  /** 仅 429 携带：需要等待的秒数。 */
  retry_after_seconds?: unknown
}

export type BackendHttpErrorInit = {
  status: number
  code?: string
  requestId?: string
  retryAfterSeconds?: number
}

/**
 * 后端返回非 2xx 时抛出的错误。
 *
 * BLF-1383 背景：过去这里 `throw new Error(message)`，把 HTTP 状态码、稳定 `code`、
 * `request_id` 和 `retry_after_seconds` 全部丢掉，登录页因此分不清「密码错 / 账号停用 /
 * 被限流 / 后端 500」，只剩一句笼统的「后端连接错误」。现在把这些契约字段带出来，
 * 上层可以按 `code` 分支。
 *
 * 它继承 `Error`，因此既有的只读 `err.message` 的调用方行为不变。
 */
export class BackendHttpError extends Error {
  readonly status: number
  readonly code?: string
  readonly requestId?: string
  readonly retryAfterSeconds?: number

  constructor(message: string, init: BackendHttpErrorInit) {
    super(message)
    this.name = 'BackendHttpError'
    this.status = init.status
    this.code = init.code
    this.requestId = init.requestId
    this.retryAfterSeconds = init.retryAfterSeconds
  }
}

function trimTrailingSlash(value: string) {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

export function getBackendBaseUrl() {
  const base =
    process.env.BACKEND_INTERNAL_URL ||
    process.env.BACKEND_API_BASE_URL ||
    'http://127.0.0.1:8100'
  return trimTrailingSlash(base)
}

export function getBackendPublicBaseUrl() {
  const base =
    process.env.BACKEND_PUBLIC_API_BASE_URL ||
    process.env.BACKEND_API_BASE_URL ||
    ''
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

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function asPositiveSeconds(value: unknown): number | undefined {
  const num = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(num) || num <= 0) return undefined
  return Math.round(num)
}

/** 先读文本再尝试解析 JSON：后端 / 网关在 5xx 时可能返回纯文本或 HTML。 */
async function readResponseBody(response: Response): Promise<{ payload: BackendErrorPayload | null; text: string }> {
  const text = await response.text()
  if (!text.trim()) return { payload: null, text: '' }
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed && typeof parsed === 'object') {
      return { payload: parsed as BackendErrorPayload, text }
    }
    return { payload: null, text }
  } catch {
    return { payload: null, text }
  }
}

export async function backendFetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${getBackendBaseUrl()}${appendApiKeyQuery(path)}`, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(5_000),
  })
  const { payload, text } = await readResponseBody(response)
  if (!response.ok) {
    const message = normalizeErrorMessage(
      payload?.message || payload?.detail || '',
      `请求后端失败 (${response.status})`,
    )
    throw new BackendHttpError(message, {
      status: response.status,
      code: asTrimmedString(payload?.code),
      requestId:
        asTrimmedString(payload?.request_id) ||
        asTrimmedString(response.headers.get('x-request-id')),
      retryAfterSeconds:
        asPositiveSeconds(payload?.retry_after_seconds) ||
        asPositiveSeconds(response.headers.get('retry-after')),
    })
  }
  if (!payload) {
    // 2xx 但没有 JSON body（如 204）。保持既有调用方可用，不因空 body 抛解析错误。
    if (!text.trim()) return undefined as T
    throw new Error(`后端返回了无法解析的响应 (${response.status})`)
  }
  return payload as T
}
