import NextAuth from 'next-auth'
import Credentials from 'next-auth/providers/credentials'

import { LoginFailureError } from '@/lib/auth/login-auth-error'
import { pageCodeFromBackendCode, pageCodeFromStatus } from '@/lib/auth/login-error-code'
import { NetworkAuthError } from '@/lib/auth/network-auth-error'
import { BackendHttpError, backendFetchJson } from '@/lib/server/backend-api'
import { rememberLoginErrorHint } from '@/lib/server/login-error-hint'

type UserCredentials = Partial<Record<'email' | 'password', unknown>>

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
            isAdmin: account.is_admin,
            operatorNameZh: account.operator_name_zh,
            roleType: account.role_type,
            sessionId: account.session_id,
          }
        } catch (err: unknown) {
          // 已经带上具体原因的失败（例如旧后端的 is_active=false）直接透传。
          if (err instanceof LoginFailureError) throw err

          // 1) 后端明确返回了失败响应：按稳定 code 选页面 code（BLF-1383）。
          //    `code` 缺省时按 HTTP 状态兜底，覆盖「前端先上线、后端还是旧版」的窗口
          //    ——旧后端 500 是纯文本，也能落到 internal_error，不再显示「后端连接错误」。
          if (err instanceof BackendHttpError) {
            const pageCode = pageCodeFromBackendCode(err.code) ?? pageCodeFromStatus(err.status, err.message)
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
    async jwt({ token, user }) {
      if (user) {
        token.uid = user.id
        token.isAdmin = Boolean(user.isAdmin)
        token.operatorNameZh = typeof user.operatorNameZh === 'string' ? user.operatorNameZh : null
        token.roleType =
          (user.roleType as 'admin' | 'operator' | 'businessdev') ??
          (user.isAdmin ? 'admin' : 'operator')
        token.sessionId = user.sessionId
      }
      return token
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = String(token.uid ?? '')
        session.user.isAdmin = Boolean(token.isAdmin)
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
