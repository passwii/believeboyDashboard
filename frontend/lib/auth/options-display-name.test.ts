import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * BLF-1441：`full_name` 从登录响应 → JWT → session 的三段透传。
 *
 * 三条规则在会话层的落点：
 *   - 后端给了 `full_name` → 原样进 token / session；
 *   - 后端给了 `null`（账号存在但没填姓名）→ token / session 里就是 `null`，
 *     **不**拿 `operator_name_zh` 或登录名补上；
 *   - 后端压根没这个字段（旧后端）→ 不写进 token，保持 `undefined`，
 *     由 `pickSessionDisplayName` 走过渡兜底。
 */

const mocks = vi.hoisted(() => ({
  backendFetchJson: vi.fn(),
  capturedConfig: { current: null as unknown },
}))

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

vi.mock('@/lib/server/backend-api', () => {
  class BackendHttpError extends Error {
    status: number
    constructor(message: string, init: { status: number }) {
      super(message)
      this.status = init.status
    }
  }
  return { BackendHttpError, backendFetchJson: mocks.backendFetchJson }
})

vi.mock('@/lib/server/login-error-hint', () => ({
  rememberLoginErrorHint: vi.fn(async () => undefined),
}))

import '@/lib/auth/options'

type Authorize = (credentials: { email?: string; password?: string }) => Promise<
  Record<string, unknown> | null
>
type JwtCallback = (params: {
  token: Record<string, unknown>
  user?: Record<string, unknown>
  trigger?: 'signIn' | 'signUp' | 'update'
  session?: unknown
}) => Promise<Record<string, unknown>>
type SessionCallback = (params: {
  session: { user?: Record<string, unknown>; expires: string }
  token: Record<string, unknown>
}) => Promise<{ user?: Record<string, unknown> }>

type CapturedConfig = {
  providers: Array<{ options: { authorize: Authorize } }>
  callbacks: { jwt: JwtCallback; session: SessionCallback }
}

function config(): CapturedConfig {
  const captured = mocks.capturedConfig.current as CapturedConfig | null
  if (!captured) throw new Error('NextAuth 配置未被捕获')
  return captured
}

const account = {
  id: 'u1',
  name: 'Yawei',
  email: 'yawei@believeboy.com',
  full_name: '纪亚伟',
  operator_name_zh: '运营A',
  is_admin: true,
  is_active: true,
  role_type: 'admin' as const,
  session_id: 's1',
}

const credentials = { email: 'yawei@believeboy.com', password: 'secret123' }

beforeEach(() => {
  mocks.backendFetchJson.mockReset()
})

describe('authorize · full_name 透传', () => {
  it('把后端 full_name 带进 user 对象', async () => {
    mocks.backendFetchJson.mockResolvedValue(account)

    const user = await config().providers[0].options.authorize(credentials)

    expect(user).toMatchObject({ fullName: '纪亚伟', operatorNameZh: '运营A', name: 'Yawei' })
  })

  it('后端 full_name 为空串时归一成 null（不拿运营名顶替）', async () => {
    mocks.backendFetchJson.mockResolvedValue({ ...account, full_name: '   ' })

    const user = await config().providers[0].options.authorize(credentials)

    expect(user?.fullName).toBeNull()
    expect(user?.operatorNameZh).toBe('运营A')
  })

  it('旧后端没有 full_name 字段时保留 undefined（交给过渡兜底）', async () => {
    const { full_name: _omit, ...legacyAccount } = account
    mocks.backendFetchJson.mockResolvedValue(legacyAccount)

    const user = await config().providers[0].options.authorize(credentials)

    expect(user).toHaveProperty('fullName', undefined)
  })
})

describe('jwt callback · full_name', () => {
  it('登录时写入 token', async () => {
    const token = await config().callbacks.jwt({
      token: {},
      user: { id: 'u1', fullName: '纪亚伟', operatorNameZh: '运营A', isAdmin: true },
    })

    expect(token.fullName).toBe('纪亚伟')
  })

  it('登录时 fullName 为 null 也写进 token（表示「没填姓名」）', async () => {
    const token = await config().callbacks.jwt({
      token: {},
      user: { id: 'u1', fullName: null, operatorNameZh: '运营A', isAdmin: false },
    })

    expect(token.fullName).toBeNull()
    expect(token.operatorNameZh).toBe('运营A')
  })

  it('旧后端（user 上没有 fullName 键）时不写 token，保持 undefined', async () => {
    const token = await config().callbacks.jwt({
      token: {},
      user: { id: 'u1', operatorNameZh: '运营A', isAdmin: false },
    })

    expect('fullName' in token).toBe(false)
  })

  it('useSession().update 改姓名时同步进 token', async () => {
    const token = await config().callbacks.jwt({
      token: { uid: 'u1', fullName: '旧名字', operatorNameZh: '运营A' },
      trigger: 'update',
      session: { user: { name: 'Yawei', fullName: '新名字' } },
    })

    expect(token.fullName).toBe('新名字')
  })

  it('update 时把姓名清空 → token 里是 null，不回落运营名', async () => {
    const token = await config().callbacks.jwt({
      token: { uid: 'u1', fullName: '旧名字', operatorNameZh: '运营A' },
      trigger: 'update',
      session: { user: { fullName: '   ' } },
    })

    expect(token.fullName).toBeNull()
  })
})

describe('session callback · full_name', () => {
  it('token 里有值 → session.user.fullName 有值', async () => {
    const session = await config().callbacks.session({
      session: { user: {}, expires: '2099-01-01T00:00:00.000Z' },
      token: { uid: 'u1', fullName: '纪亚伟', operatorNameZh: '运营A', roleType: 'admin' },
    })

    expect(session.user?.fullName).toBe('纪亚伟')
    expect(session.user?.operatorNameZh).toBe('运营A')
  })

  it('token 里是 null → session 里是 null（不是 undefined）', async () => {
    const session = await config().callbacks.session({
      session: { user: {}, expires: '2099-01-01T00:00:00.000Z' },
      token: { uid: 'u1', fullName: null, roleType: 'operator' },
    })

    expect(session.user).toHaveProperty('fullName', null)
  })

  it('旧 token 没有 fullName 键 → session 里是 undefined（走过渡兜底）', async () => {
    const session = await config().callbacks.session({
      session: { user: {}, expires: '2099-01-01T00:00:00.000Z' },
      token: { uid: 'u1', roleType: 'admin' },
    })

    expect(session.user?.fullName).toBeUndefined()
  })
})
