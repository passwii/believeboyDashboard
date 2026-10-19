/**
 * 登录失败的页面级错误码（BLF-1383）。
 *
 * 后端在 `/api/v1/auth/login` 的失败响应里给出稳定枚举 `code`（见 BLF-1381 / PR #748），
 * 前端只按 code 分支选文案，**不做自然语言匹配**、不复制后端的 message 维护一份。
 *
 * 注意 Auth.js 会把 `code` 原样放进跳转 URL（`/login?error=...&code=...`），所以这层
 * 只允许出现固定的、不泄漏账号信息的枚举值，绝不拼入 `request_id` / 邮箱 / 具体原因。
 */

export type LoginPageErrorCode =
  | 'invalid_credentials'
  | 'account_disabled'
  | 'rate_limited'
  | 'internal_error'
  | 'invalid_client_id'
  | 'network_error'
  /** NextAuth 默认的 `credentials`（authorize 返回 null，未给具体原因）。 */
  | 'generic_credentials'

export type ResolvedLoginPageErrorCode = LoginPageErrorCode | 'unknown'

/** 后端稳定 code → 页面 code。新增后端 code 时在这里追加，不要改已有映射。 */
export const BACKEND_CODE_TO_PAGE_CODE: Readonly<Record<string, LoginPageErrorCode>> = {
  LOGIN_INVALID_CREDENTIALS: 'invalid_credentials',
  LOGIN_ACCOUNT_DISABLED: 'account_disabled',
  LOGIN_RATE_LIMITED: 'rate_limited',
  LOGIN_INTERNAL_ERROR: 'internal_error',
  LOGIN_INVALID_CLIENT_ID: 'invalid_client_id',
}

const PAGE_CODES: ReadonlySet<string> = new Set<LoginPageErrorCode>([
  'invalid_credentials',
  'account_disabled',
  'rate_limited',
  'internal_error',
  'invalid_client_id',
  'network_error',
  'generic_credentials',
])

const KNOWN_BACKEND_CODES: ReadonlySet<string> = new Set(
  Object.keys(BACKEND_CODE_TO_PAGE_CODE).map((code) => code.toUpperCase()),
)

/** 后端 code（大小写不敏感）→ 页面 code；未知 code 返回 undefined。 */
export function pageCodeFromBackendCode(code: string | undefined | null): LoginPageErrorCode | undefined {
  const normalized = typeof code === 'string' ? code.trim().toUpperCase() : ''
  if (!normalized) return undefined
  return BACKEND_CODE_TO_PAGE_CODE[normalized]
}

export function isKnownBackendCode(code: string | undefined | null): boolean {
  const normalized = typeof code === 'string' ? code.trim().toUpperCase() : ''
  return normalized ? KNOWN_BACKEND_CODES.has(normalized) : false
}

/**
 * 后端没给（或不认识）`code` 时按 HTTP 状态码兜底。
 *
 * 主要服务「前端先升级、后端还是旧版」的窗口：旧后端 401 只有 `detail` 文本，
 * 429 只有 `Retry-After` 头。这里不把 500 归成密码错，正是本次报障的核心修复点。
 */
export function pageCodeFromStatus(status: number, detail?: string | null): LoginPageErrorCode {
  if (status === 429) return 'rate_limited'
  if (status === 400) return 'invalid_client_id'
  if (status >= 500) return 'internal_error'
  if (status === 401 || status === 403) {
    const text = typeof detail === 'string' ? detail.toLowerCase() : ''
    if (text.includes('disabled')) return 'account_disabled'
    return 'invalid_credentials'
  }
  return 'generic_credentials'
}

/**
 * 客户端从 `result.code` 反查页面 code。
 *
 * - 我们自己在 authorize 里抛的是页面 code（原样命中）；
 * - `credentials` / 空值 是 Auth.js v5 对「authorize 返回 null」的默认形态，沿用旧兜底文案；
 * - 其余（`Configuration` / `CallbackRouteError` …）一律 `unknown`，不做密码归因。
 */
export function resolveLoginPageErrorCode(rawCode: string | undefined | null): ResolvedLoginPageErrorCode {
  const normalized = typeof rawCode === 'string' ? rawCode.trim().toLowerCase() : ''
  if (!normalized) return 'generic_credentials'
  if (normalized === 'credentials') return 'generic_credentials'
  if (PAGE_CODES.has(normalized)) return normalized as LoginPageErrorCode
  return 'unknown'
}
