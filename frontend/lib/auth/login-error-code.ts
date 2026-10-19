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
  /**
   * 后端给了 `code`，但前端不认识（后端契约「只增不改」，属正常的新旧版本窗口）。
   *
   * 必须与「后端没给 code」区分开：前者不能按 HTTP 状态兜底，否则将来新增的
   * 401 类 code（MFA、密码过期…）会被归成「邮箱或密码错误」，正是 BLF-1383
   * 要消灭的误归因。文案走 `buildLoginErrorMessage` 的匿名兜底分支。
   */
  | 'unknown_backend_reason'

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
  'unknown_backend_reason',
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
 * 后端**没给** `code` 时按 HTTP 状态码兜底（只适用于旧后端 / 网关纯文本响应）。
 *
 * 主要服务「前端先升级、后端还是旧版」的窗口：旧后端 401 只有 `detail` 文本，
 * 429 只有 `Retry-After` 头。这里不把 500 归成密码错，正是本次报障的核心修复点。
 *
 * ❗ 不要用它处理「后端给了 code 但前端不认识」：那条路必须走
 * `pageCodeForBackendFailure`，归成 `unknown_backend_reason`，而不是按 401 回退成密码错。
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
 * 后端失败响应 → 页面 code 的唯一入口（BLF-1383）。
 *
 * 三条优先级，顺序不可调换：
 *
 * 1. 后端给了**认识**的 `code` → 按 code 映射（后端契约「只增不改」）；
 * 2. 后端**没给** `code`（旧后端 / 网关纯文本 5xx）→ 按 HTTP 状态兜底；
 * 3. 后端给了 `code` 但前端**不认识** → `unknown_backend_reason`，**不**降级成状态兜底。
 *
 * 第 3 条是关键：后端将来新增 401 类 code（MFA、密码过期…）时，若走状态兜底会
 * 显示「邮箱或密码错误」，那是错误归因；宁可给匿名兜底文案 + 错误码 + 请求 ID。
 */
export function pageCodeForBackendFailure(
  code: string | undefined | null,
  status: number,
  detail?: string | null,
): LoginPageErrorCode {
  const mapped = pageCodeFromBackendCode(code)
  if (mapped) return mapped
  if (typeof code === 'string' && code.trim()) return 'unknown_backend_reason'
  return pageCodeFromStatus(status, detail)
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
