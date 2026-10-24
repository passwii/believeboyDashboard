import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * BLF-1441：`full_name` 从登录响应 → JWT → session 的三段透传。
 *
 * 三条规则在会话层的落点：
 *   - 后端给了 `full_name` → 原样进 token / session；
 *   - 后端给了 `null`（账号存在但没填姓名）→ token / session 里就是 `null`，
 *     **不**拿登录名补上（运营名字段已随后端 #778 删除）；
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

import { BackendHttpError } from '@/lib/server/backend-api'

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

    expect(user).toMatchObject({ fullName: '纪亚伟', name: 'Yawei' })
    // 运营名已删（#778）：authorize 不再透出这个字段。
    expect(user).not.toHaveProperty('operatorNameZh')
  })

  it('后端 full_name 为空串时归一成 null（不拿登录名顶替）', async () => {
    mocks.backendFetchJson.mockResolvedValue({ ...account, full_name: '   ' })

    const user = await config().providers[0].options.authorize(credentials)

    expect(user?.fullName).toBeNull()
    expect(user).not.toHaveProperty('operatorNameZh')
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
      user: { id: 'u1', fullName: '纪亚伟', isAdmin: true },
    })

    expect(token.fullName).toBe('纪亚伟')
  })

  it('登录时 fullName 为 null 也写进 token（表示「没填姓名」）', async () => {
    const token = await config().callbacks.jwt({
      token: {},
      user: { id: 'u1', fullName: null, isAdmin: false },
    })

    expect(token.fullName).toBeNull()
    expect(token).not.toHaveProperty('operatorNameZh')
  })

  it('旧后端（user 上没有 fullName 键）时不写 token，保持 undefined', async () => {
    const token = await config().callbacks.jwt({
      token: {},
      user: { id: 'u1', isAdmin: false },
    })

    expect('fullName' in token).toBe(false)
  })
})

/**
 * review P1：`useSession().update(data)` 是客户端可自行构造的
 * `POST /api/auth/session`，它提交的姓名**绝不能**成为 token 里的身份。
 * 唯一可信来源是用 token 里服务端签发的 uid / email / sessionId 回源
 * `GET /api/v1/auth/me` 的结果。
 */
describe('jwt callback · update 回源（客户端姓名不可信）', () => {
  const IDENTITY = { uid: 'u1', email: 'yawei@believeboy.com', sessionId: 's1' }
  const oldToken = () => ({ ...IDENTITY, fullName: '旧名字', name: 'Yawei' })

  it('客户端传别人的名字 → 不采纳，以后端返回值为准', async () => {
    mocks.backendFetchJson.mockResolvedValue({
      id: 'u1',
      name: 'Yawei',
      email: 'yawei@believeboy.com',
      full_name: '旧名字',
    })

    const token = await config().callbacks.jwt({
      // 攻击姿势：临时账号把自己的 fullName 改成别人的名字，想拿别人的项目权限。
      token: { ...oldToken(), fullName: '临时账号' },
      trigger: 'update',
      session: { user: { name: '纪亚伟', fullName: '纪亚伟' } },
    })

    expect(token.fullName).toBe('旧名字')
    expect(token.name).toBe('Yawei')
  })

  it('后端返回新姓名 → 以返回值为准落进 token', async () => {
    mocks.backendFetchJson.mockResolvedValue({ name: 'Yawei', full_name: '纪亚伟' })

    const token = await config().callbacks.jwt({
      token: oldToken(),
      trigger: 'update',
      session: { user: { fullName: '客户端乱写的名字' } },
    })

    expect(token.fullName).toBe('纪亚伟')
  })

  it('回源 401（会话吊销 / 账号停用）→ 保留 token 原值，不清空不降级', async () => {
    mocks.backendFetchJson.mockRejectedValue(
      new BackendHttpError('Session revoked', { status: 401 })
    )

    const token = await config().callbacks.jwt({
      token: oldToken(),
      trigger: 'update',
      session: { user: { fullName: '客户端乱写的名字' } },
    })

    expect(token.fullName).toBe('旧名字')
    expect(token.name).toBe('Yawei')
  })

  it('后端不可达 → 保留 token 原值', async () => {
    mocks.backendFetchJson.mockRejectedValue(new Error('fetch failed'))

    const token = await config().callbacks.jwt({
      token: oldToken(),
      trigger: 'update',
      session: { user: { fullName: '客户端乱写的名字' } },
    })

    expect(token.fullName).toBe('旧名字')
  })

  it('token 缺 sessionId 时不发请求（不回源就不更新）', async () => {
    const token = await config().callbacks.jwt({
      token: { uid: 'u1', email: 'yawei@believeboy.com', fullName: '旧名字' },
      trigger: 'update',
      session: { user: { fullName: '客户端乱写的名字' } },
    })

    expect(mocks.backendFetchJson).not.toHaveBeenCalled()
    expect(token.fullName).toBe('旧名字')
  })

  it('后端明确返回 full_name=null → token 置 null（不是保留旧值，也不回落登录名）', async () => {
    mocks.backendFetchJson.mockResolvedValue({ name: 'DamonROCK', full_name: null })

    const token = await config().callbacks.jwt({
      token: { ...IDENTITY, fullName: '旧名字', name: 'DamonROCK' },
      trigger: 'update',
      session: { user: { fullName: '旧名字' } },
    })

    expect(token.fullName).toBeNull()
  })

  it('旧后端响应没有 full_name 键 → 保持 token 原值', async () => {
    mocks.backendFetchJson.mockResolvedValue({ name: 'Yawei' })

    const token = await config().callbacks.jwt({
      token: oldToken(),
      trigger: 'update',
      session: { user: { fullName: '客户端乱写的名字' } },
    })

    expect(token.fullName).toBe('旧名字')
  })

  it('回源带 token 里的服务端身份，而不是客户端提交的任何东西', async () => {
    mocks.backendFetchJson.mockResolvedValue({ name: 'Yawei', full_name: '纪亚伟' })

    await config().callbacks.jwt({
      token: oldToken(),
      trigger: 'update',
      session: { user: { id: 'u2', email: 'someone@else.com', fullName: '纪亚伟' } },
    })

    const [path, init] = mocks.backendFetchJson.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/api/v1/auth/me')
    expect(init.method).toBe('GET')
    const headers = init.headers as Record<string, string>
    expect(headers['X-User-Id']).toBe('u1')
    expect(headers['X-User-Email']).toBe('yawei%40believeboy.com')
    expect(headers['X-Session-Id']).toBe('s1')
  })
})

describe('session callback · full_name', () => {
  it('token 里有值 → session.user.fullName 有值', async () => {
    const session = await config().callbacks.session({
      session: { user: {}, expires: '2099-01-01T00:00:00.000Z' },
      token: { uid: 'u1', fullName: '纪亚伟', roleType: 'admin' },
    })

    expect(session.user?.fullName).toBe('纪亚伟')
    // 运营名已删（#778）：session 不再携带这个字段。
    expect(session.user).not.toHaveProperty('operatorNameZh')
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
