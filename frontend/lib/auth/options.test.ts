import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `authorize()` 的错误码映射（BLF-1383）。
 *
 * 后端契约（BLF-1381 / PR #748）：失败响应带稳定 `code` + `request_id` +
 * 可选 `retry_after_seconds`。这里锁住「后端 code → Auth.js code」的映射，
 * 这是登录页能显示具体失败原因的唯一通道。
 */

const mocks = vi.hoisted(() => {
  class BackendHttpError extends Error {
    status: number
    code?: string
    requestId?: string
    retryAfterSeconds?: number

    constructor(
      message: string,
      init: { status: number; code?: string; requestId?: string; retryAfterSeconds?: number },
    ) {
      super(message)
      this.name = 'BackendHttpError'
      this.status = init.status
      this.code = init.code
      this.requestId = init.requestId
      this.retryAfterSeconds = init.retryAfterSeconds
    }
  }

  return {
    BackendHttpError,
    backendFetchJson: vi.fn(),
    rememberLoginErrorHint: vi.fn(async () => undefined),
    capturedConfig: { current: null as unknown },
  }
})

vi.mock('next-auth', () => {
  class CredentialsSignin extends Error {
    type = 'CredentialsSignin'
    kind = 'signIn'
    code = 'credentials'
  }
  class AuthError extends Error {}
  const NextAuth = (config: unknown) => {
    mocks.capturedConfig.current = config
    return { handlers: {}, signIn: vi.fn(), signOut: vi.fn(), auth: vi.fn() }
  }
  return { default: NextAuth, CredentialsSignin, AuthError }
})

vi.mock('next-auth/providers/credentials', () => ({
  default: (config: unknown) => ({ id: 'credentials', type: 'credentials', options: config }),
}))

vi.mock('@/lib/server/backend-api', () => ({
  BackendHttpError: mocks.BackendHttpError,
  backendFetchJson: mocks.backendFetchJson,
}))

vi.mock('@/lib/server/login-error-hint', () => ({
  rememberLoginErrorHint: mocks.rememberLoginErrorHint,
}))

import '@/lib/auth/options'

type Credentials = { email?: string; password?: string }
type AuthorizeResult = {
  id: string
  email: string
  isAdmin: boolean
  roleType: 'admin' | 'operator' | 'businessdev'
  sessionId: string
  [key: string]: unknown
}
type Authorize = (credentials: Credentials) => Promise<AuthorizeResult | null>
type CapturedConfig = {
  providers: Array<{ options: { authorize: Authorize } }>
}

function authorize(): Authorize {
  const config = mocks.capturedConfig.current as CapturedConfig | null
  if (!config) throw new Error('NextAuth 配置未被捕获')
  return config.providers[0].options.authorize
}

function backendError(
  status: number,
  init: { code?: string; requestId?: string; retryAfterSeconds?: number } = {},
) {
  return new mocks.BackendHttpError('backend failed', { status, ...init })
}

const account = {
  id: 'u1',
  name: 'Damon',
  email: 'a@b.com',
  operator_name_zh: '戴蒙',
  is_admin: true,
  is_active: true,
  role_type: 'admin' as const,
  session_id: 's1',
}

const credentials: Credentials = { email: 'a@b.com', password: 'secret123' }

beforeEach(() => {
  mocks.backendFetchJson.mockReset()
  mocks.rememberLoginErrorHint.mockClear()
})

describe('authorize 错误码映射', () => {
  it('成功时返回用户并保留既有字段', async () => {
    mocks.backendFetchJson.mockResolvedValue(account)

    const user = await authorize()(credentials)

    expect(user).toMatchObject({ id: 'u1', email: 'a@b.com', isAdmin: true, sessionId: 's1' })
  })

  it.each([
    ['LOGIN_INVALID_CREDENTIALS', 401, 'invalid_credentials'],
    ['LOGIN_ACCOUNT_DISABLED', 401, 'account_disabled'],
    ['LOGIN_INTERNAL_ERROR', 500, 'internal_error'],
    ['LOGIN_INVALID_CLIENT_ID', 400, 'invalid_client_id'],
  ] as const)('后端 code %s 映射成 %s', async (backendCode: string, status: number, pageCode: string) => {
    mocks.backendFetchJson.mockRejectedValue(
      backendError(status, { code: backendCode, requestId: 'req-1' }),
    )

    await expect(authorize()(credentials)).rejects.toMatchObject({ code: pageCode })
    expect(mocks.rememberLoginErrorHint).toHaveBeenCalledWith(
      expect.objectContaining({ backendCode, requestId: 'req-1' }),
    )
  })

  it('限流把 retry_after_seconds 一并存进排查线索 cookie', async () => {
    mocks.backendFetchJson.mockRejectedValue(
      backendError(429, {
        code: 'LOGIN_RATE_LIMITED',
        requestId: 'req-2',
        retryAfterSeconds: 42,
      }),
    )

    await expect(authorize()(credentials)).rejects.toMatchObject({ code: 'rate_limited' })
    expect(mocks.rememberLoginErrorHint).toHaveBeenCalledWith(
      expect.objectContaining({ retryAfterSeconds: 42 }),
    )
  })

  it('后端给了前端不认识的 code 时不归成密码错（含 401）', async () => {
    // 回归点（BLF-1383 review）：code 存在但不认识时，不能回落到状态码兜底。
    mocks.backendFetchJson.mockRejectedValue(
      backendError(401, { code: 'LOGIN_MFA_REQUIRED', requestId: 'req-mfa' }),
    )

    const result = authorize()(credentials)
    await expect(result).rejects.toMatchObject({ code: 'unknown_backend_reason' })
    await expect(result).rejects.not.toMatchObject({ code: 'invalid_credentials' })
    // 后端 code 仍要进排查线索 cookie，页面上要能看到到底是哪个新原因。
    expect(mocks.rememberLoginErrorHint).toHaveBeenCalledWith(
      expect.objectContaining({ backendCode: 'LOGIN_MFA_REQUIRED', requestId: 'req-mfa' }),
    )
  })

  it('旧后端 500 没有 code 时按状态归成 internal_error（不再冒充密码错）', async () => {
    mocks.backendFetchJson.mockRejectedValue(backendError(500))

    await expect(authorize()(credentials)).rejects.toMatchObject({ code: 'internal_error' })
  })

  it('旧后端 401 只有 detail 文本时区分停用', async () => {
    mocks.backendFetchJson.mockRejectedValue(new mocks.BackendHttpError('Account disabled', { status: 401 }))

    await expect(authorize()(credentials)).rejects.toMatchObject({ code: 'account_disabled' })
  })

  it('连不上后端仍然是 network_error（保留重试语义）', async () => {
    mocks.backendFetchJson.mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(authorize()(credentials)).rejects.toMatchObject({ code: 'network_error' })
    expect(mocks.rememberLoginErrorHint).not.toHaveBeenCalled()
  })

  it('未预期异常按内部错误上报，不归成密码错', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.backendFetchJson.mockRejectedValue(new Error('boom'))

    await expect(authorize()(credentials)).rejects.toMatchObject({ code: 'internal_error' })
    errorSpy.mockRestore()
  })

  it('后端说账号未启用时抛 account_disabled 而不是笼统失败', async () => {
    mocks.backendFetchJson.mockResolvedValue({ ...account, is_active: false })

    await expect(authorize()(credentials)).rejects.toMatchObject({ code: 'account_disabled' })
  })
})
