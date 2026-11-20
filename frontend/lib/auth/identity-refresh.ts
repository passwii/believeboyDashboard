import { normalizeFullName, pickSessionDisplayName } from '@/lib/auth/display-name'
import { invalidateBackendSessionValidation } from '@/lib/auth/session-validation'
import { backendFetchJson } from '@/lib/server/backend-api'

/**
 * BLF-1441（review P1）· `useSession().update()` 的权威身份回源。
 *
 * ## 为什么需要这一层
 *
 * NextAuth v5 的 `update(data)` 就是 `POST /api/auth/session`，body 由浏览器
 * 完全控制：任何**已登录**用户都能自己发这个请求，不需要改 cookie、不需要碰
 * 签名。而 `X-Operator` 同时是项目鉴权的匹配键（后端 `get_request_operator`
 * 直接信任该头，`list_project_items` / `ensure_project_access` 拿它跟
 * `projects.project_operator` 做文本匹配）。因此「客户端传什么姓名，jwt 回调
 * 就写什么」等于把项目权限的入口交给客户端——把 `fullName` 改成别人的名字，
 * 就能看/改别人名下的项目。这不是显示名问题，是越权。
 *
 * 所以 `trigger === 'update'` 时**不读** `session.user` 里的任何姓名，只拿 token
 * 里那些由服务端签发、客户端改不了的身份（`uid` / `email` / `sessionId`）回源
 * `GET /api/v1/auth/me`：
 *
 * - 该端点按 `id` + `email` 查真实账号，并用 `X-Session-Id` 校验 Redis 会话
 *   （账号停用 / 会话吊销会直接 401）；
 * - 它返回 `user_accounts.full_name`（#775 起下发）。
 *
 * ## 失败时的口径
 *
 * 回源失败（后端不可达 / 401 / 404 / 超时）返回 `null`，调用方**保持 token 原值**：
 * 本次 update 不生效，等下次登录或下一次刷新。绝不清空，也绝不降级去用客户端
 * 提交的值——「宁可旧名字，也不接受未经验证的名字」。
 */

/** token 里参与回源的身份字段（都来自服务端签发的 JWT，客户端不可控）。 */
export type SessionIdentityToken = {
  iat?: unknown
  uid?: unknown
  email?: unknown
  name?: unknown
  fullName?: unknown
  isAdmin?: unknown
  roleType?: unknown
  sessionId?: unknown
}

export type SessionIdentity = {
  /** 权威登录名（`user_accounts.name`）；响应里没有就不动 token。 */
  name?: string
  isAdmin?: boolean
  roleType?: 'admin' | 'operator' | 'businessdev'
  /**
   * 权威姓名三态，与 `normalizeFullName` 一致：
   * `undefined` = 响应里没这个键（旧后端）→ 保持 token 原值；
   * `null` = 后端明确没填姓名 → 落 null；字符串 = 已 trim 的姓名。
   */
  fullName: string | null | undefined
}

type AuthMePayload = {
  name?: unknown
  full_name?: unknown
  is_admin?: unknown
  role_type?: unknown
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

/**
 * 用 token 里的身份回源 `/api/v1/auth/me`，返回权威姓名；任何失败都返回 `null`。
 *
 * 身份与角色来自服务端签名 token，缺少 sessionId 时不发请求。JWT 签发时间只作为
 * 旧 Redis session value 的密码更新时间校验回退；新 session 使用 Redis 内的签发时间。
 * Go `/auth/me` 校验 Redis session、账号状态、当前角色和密码更新时间。
 */
export async function fetchSessionIdentity(
  token: SessionIdentityToken
): Promise<SessionIdentity | null> {
  const uid = asTrimmedString(token.uid)
  const email = asTrimmedString(token.email)
  const sessionId = asTrimmedString(token.sessionId)
  if (!uid || !email || !sessionId) return null

  try {
    const roleType =
      token.roleType === 'admin' || token.roleType === 'businessdev' || token.roleType === 'operator'
        ? token.roleType
        : token.isAdmin === true
          ? 'admin'
          : 'operator'
    const fullName = normalizeFullName(token.fullName)
    const operator = pickSessionDisplayName({
      fullName,
      name: asTrimmedString(token.name),
    })
    const headers: Record<string, string> = {
      'X-User-Id': uid,
      // Keep identity headers aligned with backend-auth.ts; the JWT values are
      // server-signed and are used only as the lookup identity for /auth/me.
      'X-User-Email': encodeURIComponent(email),
      'X-Role-Type': roleType,
      'X-Session-Id': sessionId,
      'X-Auth-Identity-Refresh': 'true',
    }
    if (typeof token.iat === 'number' && Number.isFinite(token.iat) && token.iat > 0) {
      headers['X-Session-Issued-At'] = String(Math.floor(token.iat))
    }
    if (token.isAdmin === true || roleType === 'admin') headers['X-Is-Admin'] = 'true'
    if (operator) {
      headers['X-User-Name'] = encodeURIComponent(operator)
      headers['X-Operator'] = encodeURIComponent(operator)
    }

    const me = await backendFetchJson<AuthMePayload>('/api/v1/auth/me', {
      method: 'GET',
      headers,
      cache: 'no-store',
    })
    if (!me || typeof me !== 'object') return null
    invalidateBackendSessionValidation(uid, sessionId)

    const identity: SessionIdentity = { fullName: undefined }
    if ('full_name' in me) {
      identity.fullName = normalizeFullName(me.full_name)
    }
    const name = asTrimmedString(me.name)
    if (name) identity.name = name
    if (typeof me.is_admin === 'boolean') identity.isAdmin = me.is_admin
    if (me.role_type === 'admin' || me.role_type === 'operator' || me.role_type === 'businessdev') {
      identity.roleType = me.role_type
    }
    return identity
  } catch {
    // 后端不可达 / 401（会话吊销、账号停用）/ 404：本次 update 不生效。
    return null
  }
}
