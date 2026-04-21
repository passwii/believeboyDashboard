import type { NextAuthOptions } from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'

import { backendFetchJson } from '@/lib/server/backend-api'

export const authOptions: NextAuthOptions = {
  session: { 
    strategy: 'jwt',
    maxAge: 72 * 60 * 60, // 72小时过期
  },
  pages: { signIn: '/login' },
  providers: [
    CredentialsProvider({
      name: 'credentials',
      credentials: {
        email: { label: '邮箱', type: 'email' },
        password: { label: '密码', type: 'password' },
      },
      async authorize(credentials) {
        const email = credentials?.email?.trim().toLowerCase() ?? ''
        const password = credentials?.password ?? ''

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
            role_type: 'admin' | 'operator' | 'businessdev' | 'factory'
          }>('/api/v1/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
            cache: 'no-store',
          })
          if (!account.is_active) return null
          return {
            id: account.id,
            name: account.name,
            email: account.email,
            isAdmin: account.is_admin,
            operatorNameZh: account.operator_name_zh,
            roleType: account.role_type,
          }
        } catch {
          return null
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
        token.roleType = (user.roleType as 'admin' | 'operator' | 'businessdev' | 'factory') ?? (user.isAdmin ? 'admin' : 'operator')
      }
      return token
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = String(token.uid ?? '')
        session.user.isAdmin = Boolean(token.isAdmin)
        session.user.operatorNameZh = typeof token.operatorNameZh === 'string' ? token.operatorNameZh : null
        session.user.roleType = (token.roleType as 'admin' | 'operator' | 'businessdev' | 'factory') ?? (token.isAdmin ? 'admin' : 'operator')
      }
      return session
    },
  },
}
