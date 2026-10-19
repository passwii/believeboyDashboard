/**
 * 登录失败排查线索的短 TTL cookie（BLF-1383）。
 *
 * 背景：Auth.js 只把 `CredentialsSignin.code` 透传到客户端，`request_id` 与
 * `retry_after_seconds` 在后端 body 里、到不了登录页。用户最需要「能拿去排查」的东西，
 * 所以 authorize 失败时把它们写进一个 2 分钟 TTL 的 cookie，登录页读完即清。
 *
 * 取舍：
 * - **不放 message**：文案由页面按 code 决定，避免前端再维护一份后端文案；
 * - cookie 值只是诊断信息（code / 请求 ID / 等待秒数），不涉及凭据，故非 httpOnly；
 * - 同时限长 + 白名单字段，读回时全部重新校验，cookie 被篡改也不会 XSS 注入文案。
 *
 * 文件名不带 `server/` 前缀是因为「编码 / 解码 / 取值」是前后端共用的纯逻辑；
 * 只有写 cookie 的部分（依赖 `next/headers`）放在 `lib/server/login-error-hint.ts`。
 */

export const LOGIN_ERROR_HINT_COOKIE = 'believeboy_login_error_hint'

/** 2 分钟：够用户读完并复制请求 ID，又不会在下一次正常登录时误报旧错误。 */
export const LOGIN_ERROR_HINT_MAX_AGE_SECONDS = 120

export type LoginErrorHint = {
  /** 后端原始稳定 code（如 `LOGIN_INTERNAL_ERROR`），展示给用户便于报障。 */
  backendCode?: string
  /** 与响应头 `X-Request-Id` 同值。 */
  requestId?: string
  /** 仅 429：后端建议的等待秒数（用于倒计时）。 */
  retryAfterSeconds?: number
}

const MAX_CODE_LENGTH = 64
const MAX_REQUEST_ID_LENGTH = 128
const MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60
/** 值版本号：格式调整时递增，旧值自然失效而不是被误读。 */
const HINT_VERSION = 'v1'
const HINT_SEPARATOR = '~'

function sanitizeCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const cleaned = value.trim().slice(0, MAX_CODE_LENGTH)
  // 只允许后端枚举形态：大写字母、数字、下划线
  return /^[A-Z0-9_]+$/.test(cleaned) ? cleaned : undefined
}

function sanitizeRequestId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const cleaned = value.trim().slice(0, MAX_REQUEST_ID_LENGTH)
  return /^[A-Za-z0-9._-]+$/.test(cleaned) ? cleaned : undefined
}

function sanitizeRetryAfter(value: unknown): number | undefined {
  const num = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(num) || num <= 0) return undefined
  return Math.min(Math.round(num), MAX_RETRY_AFTER_SECONDS)
}

export function encodeLoginErrorHint(hint: LoginErrorHint): string | null {
  const backendCode = sanitizeCode(hint.backendCode) ?? ''
  const requestId = sanitizeRequestId(hint.requestId) ?? ''
  const retryAfterSeconds = sanitizeRetryAfter(hint.retryAfterSeconds)
  if (!backendCode && !requestId && retryAfterSeconds === undefined) return null
  // 紧凑格式而非 JSON：值里只有 `[A-Za-z0-9._-]` 与分隔符 `~`，都在 cookie 安全字符集内
  // （`~` 不会被 encodeURIComponent 转义），因此不会被 Next 的 Set-Cookie 序列化二次编码。
  // 实证过 JSON + encodeURIComponent 会被写成 `%257B…`，客户端读不回来。
  return [HINT_VERSION, backendCode, requestId, String(retryAfterSeconds ?? '')].join(HINT_SEPARATOR)
}

/**
 * cookie 原值可能被中间层再编码一次（Next 的 Set-Cookie 会对值 `encodeURIComponent`），
 * 这里先归一一次；`~` 本身不参与编码，所以正常路径不会变化。
 */
function normalizeRawHint(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('%')) return trimmed
  try {
    return decodeURIComponent(trimmed)
  } catch {
    return trimmed
  }
}

export function decodeLoginErrorHint(raw: string | undefined | null): LoginErrorHint | null {
  if (typeof raw !== 'string') return null
  const value = normalizeRawHint(raw)
  if (!value) return null
  const parts = value.split(HINT_SEPARATOR)
  if (parts.length !== 4 || parts[0] !== HINT_VERSION) return null
  const hint: LoginErrorHint = {
    backendCode: sanitizeCode(parts[1]),
    requestId: sanitizeRequestId(parts[2]),
    retryAfterSeconds: sanitizeRetryAfter(parts[3]),
  }
  if (!hint.backendCode && !hint.requestId && hint.retryAfterSeconds === undefined) return null
  return hint
}

/** 从 `document.cookie` 字符串里取 hint（纯函数，便于单测；不依赖浏览器全局）。 */
export function readLoginErrorHintFromCookieString(cookieString: string | undefined | null): LoginErrorHint | null {
  if (!cookieString) return null
  for (const part of cookieString.split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    if (part.slice(0, index).trim() !== LOGIN_ERROR_HINT_COOKIE) continue
    return decodeLoginErrorHint(part.slice(index + 1).trim())
  }
  return null
}

/** 浏览器端读取（登录页是 client component）。服务端渲染时返回 null。 */
export function readLoginErrorHint(): LoginErrorHint | null {
  if (typeof document === 'undefined') return null
  return readLoginErrorHintFromCookieString(document.cookie)
}

/** 读完即清，避免下次正常打开登录页时还挂着上一次的请求 ID。 */
export function clearLoginErrorHint(): void {
  if (typeof document === 'undefined') return
  document.cookie = `${LOGIN_ERROR_HINT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`
}

/** 展示用：请求 ID 取前 8 位，够在日志里定位又不会占满一行。 */
export function formatRequestId(requestId: string | undefined | null): string | null {
  const sanitized = sanitizeRequestId(requestId)
  return sanitized ? sanitized.slice(0, 8) : null
}
