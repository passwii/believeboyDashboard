import type { NextAuthOptions } from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'

import { getDbPool } from '@/lib/server/db'

export const authOptions: NextAuthOptions = {
  session: { strategy: 'jwt' },
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

        const pool = getDbPool()
        const result = await pool.query<{
          id: string
          name: string
          email: string
          is_admin: boolean
          is_active: boolean
        }>(
          `
          select
            id::text as id,
            name,
            email,
            is_admin,
            is_active
          from public.user_accounts
          where lower(email) = lower($1)
            and is_active = true
            and password_hash = crypt($2, password_hash)
          limit 1
          `,
          [email, password]
        )

        const account = result.rows[0]
        if (!account) {
          return null
        }

        return {
          id: account.id,
          name: account.name,
          email: account.email,
          isAdmin: account.is_admin,
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.uid = user.id
        token.isAdmin = Boolean(user.isAdmin)
      }
      return token
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = String(token.uid ?? '')
        session.user.isAdmin = Boolean(token.isAdmin)
      }
      return session
    },
  },
}
