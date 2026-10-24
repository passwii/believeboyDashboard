import NextAuth from 'next-auth'
import Credentials from 'next-auth/providers/credentials'

import { LoginFailureError } from '@/lib/auth/login-auth-error'
import { pageCodeForBackendFailure } from '@/lib/auth/login-error-code'
import { NetworkAuthError } from '@/lib/auth/network-auth-error'
import { BackendHttpError, backendFetchJson } from '@/lib/server/backend-api'
import { rememberLoginErrorHint } from '@/lib/server/login-error-hint'

type UserCredentials = Partial<Record<'email' | 'password', unknown>>

/**
 * 把后端 `full_name` 归一成「键存在 / 键缺失」两态（BLF-1441）。
 *
 * - `undefined`：登录响应里根本没有这个字段（前端先上线、后端还是旧版）→
 *   保留 `undefined`，让 `pickSessionDisplayName` 走过渡兜底。
 * - `null` / 空串：后端明确说「这个账号没填姓名」→ 归一成 `null`，
 *   会话里就带着这个 `null`，展示端按「未命名」处理，**不**回落登录名。
 */
function normalizeFullName(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  // Cloudflare Tunnel 会改 Host 头；这里显式声明信任，避免 v5 在生产模式
  // 下抛 `UntrustedHost: Host must be trusted` (errors.authjs.dev#untrustedhost)。
  // NEXTAUTH_URL=https://dash.believeboy.com 仍然作为 callback / cookie 的 origin 基址。
  trustHost: true,
  session: {
    strategy: 'jwt',
    maxAge: 8 * 60 * 60, // 8小时 — 活跃续期由 Redis 滑动窗口控制
  },
  pages: { signIn: '/login' },
  providers: [
    Credentials({
      credentials: {
        email: { label: '邮箱', type: 'email' },
        password: { label: '密码', type: 'password' },
      },
      async authorize(credentials: UserCredentials) {
        const email = (credentials?.email as string | undefined)?.trim().toLowerCase() ?? ''
        const password = (credentials?.password as string | undefined) ?? ''

        if (!email || !password) {
          return null
        }
        try {
          const account = await backendFetchJson<{
            id: string
            name: string
            email: string
            /** BLF-1441：全局显示名唯一来源；旧后端没有这个字段。 */
            full_name?: string | null
            operator_name_zh: string | null
            is_admin: boolean
            is_active: boolean
            role_type: 'admin' | 'operator' | 'businessdev'
            session_id: string
          }>('/api/v1/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
            cache: 'no-store',
          })
          if (!account.is_active) {
            // 正常链路后端会先回 401 LOGIN_ACCOUNT_DISABLED；这里兜住旧后端。
            throw new LoginFailureError('account_disabled')
          }
          return {
            id: account.id,
            name: account.name,
            email: account.email,
            // `undefined`（旧后端）保留为 undefined，交给 pickSessionDisplayName
            // 走过渡兜底；`null` 是「账号存在但没填姓名」，必须原样落进会话。
            fullName: normalizeFullName(account.full_name),
            isAdmin: account.is_admin,
            operatorNameZh: account.operator_name_zh,
            roleType: account.role_type,
            sessionId: account.session_id,
          }
        } catch (err: unknown) {
          // 已经带上具体原因的失败（例如旧后端的 is_active=false）直接透传。
          if (err instanceof LoginFailureError) throw err

          // 1) 后端明确返回了失败响应：按稳定 code 选页面 code（BLF-1383）。
          //    优先级见 `pageCodeForBackendFailure`：认识的 code → 无 code 时按状态兜底
          //    （覆盖「前端先上线、后端还是旧版」的窗口，旧后端 500 是纯文本也能落到
          //    internal_error）→ code 存在但不认识时走匿名兜底，**不**按状态归成密码错。
          if (err instanceof BackendHttpError) {
            const pageCode = pageCodeForBackendFailure(err.code, err.status, err.message)
            // 排查线索（请求 ID / 等待秒数）走短 TTL cookie，因为 Auth.js 只透传 code。
            await rememberLoginErrorHint({
              backendCode: err.code,
              requestId: err.requestId,
              retryAfterSeconds: err.retryAfterSeconds,
            })
            throw new LoginFailureError(pageCode)
          }

          // 2) 连不上后端：抛出 CredentialsSignin 子类，确保 NextAuth 正确传递错误类型
          const errorMessage = (err instanceof Error ? err.message : String(err)).toLowerCase()
          const isNetworkError =
            errorMessage.includes('fetch') ||
            errorMessage.includes('network') ||
            errorMessage.includes('timeout') ||
            errorMessage.includes('connection') ||
            errorMessage.includes('econnrefused') ||
            errorMessage.includes('enotfound') ||
            errorMessage.includes('failed to fetch') ||
            errorMessage.includes('typeerror')

          if (isNetworkError) throw new NetworkAuthError()

          // 3) 其它未预期异常：按「登录服务内部错误」上报，绝不归成「密码错误」。
          console.error('登录异常（未预期）:', err)
          throw new LoginFailureError('internal_error')
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user, trigger, session }) {
      if (user) {
        token.uid = user.id
        token.isAdmin = Boolean(user.isAdmin)
        // BLF-1441：`undefined` 不写进 token（旧后端 / 旧 token 语义），
        // `null` 写进去表示「账号存在但没填姓名」。
        if (user.fullName !== undefined) {
          token.fullName = typeof user.fullName === 'string' ? user.fullName : null
        }
        token.operatorNameZh = typeof user.operatorNameZh === 'string' ? user.operatorNameZh : null
        token.roleType =
          (user.roleType as 'admin' | 'operator' | 'businessdev') ??
          (user.isAdmin ? 'admin' : 'operator')
        token.sessionId = user.sessionId
      }

      // `useSession().update(...)` 触发：资料页改完「姓名」后要立刻生效。
      // 不接这段的话，token 里的 fullName 会停在登录那一刻，顶部菜单与
      // X-Operator 仍是旧名字，直到用户下次登录（最长 8 小时）。
      if (trigger === 'update' && session && typeof session === 'object') {
        const nextUser = (session as { user?: { fullName?: unknown; name?: unknown } }).user
        if (nextUser && typeof nextUser === 'object') {
          if ('fullName' in nextUser) {
            token.fullName =
              typeof nextUser.fullName === 'string'
                ? (normalizeFullName(nextUser.fullName) ?? null)
                : null
          }
          if (typeof nextUser.name === 'string') {
            token.name = nextUser.name
          }
        }
      }
      return token
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = String(token.uid ?? '')
        session.user.isAdmin = Boolean(token.isAdmin)
        // 三态透传：`undefined` = 旧 token（本改动前签发），由
        // pickSessionDisplayName 走过渡兜底；`null` = 后端明确没填姓名。
        session.user.fullName =
          token.fullName === undefined
            ? undefined
            : typeof token.fullName === 'string'
              ? token.fullName
              : null
        session.user.operatorNameZh =
          typeof token.operatorNameZh === 'string' ? token.operatorNameZh : null
        session.user.roleType =
          (token.roleType as 'admin' | 'operator' | 'businessdev') ??
          (token.isAdmin ? 'admin' : 'operator')
        session.user.sessionId = typeof token.sessionId === 'string' ? token.sessionId : undefined
      }
      return session
    },
  },
})
