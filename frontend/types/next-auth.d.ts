import { DefaultSession } from 'next-auth'

declare module 'next-auth' {
  interface Session {
    user: {
      id: string
      isAdmin: boolean
      operatorNameZh?: string | null
      roleType: 'admin' | 'operator' | 'businessdev'
      sessionId?: string
    } & DefaultSession['user']
  }

  interface User {
    id: string
    isAdmin: boolean
    operatorNameZh?: string | null
    roleType?: 'admin' | 'operator' | 'businessdev'
    sessionId?: string
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    uid?: string
    isAdmin?: boolean
    operatorNameZh?: string | null
    roleType?: 'admin' | 'operator' | 'businessdev'
    sessionId?: string
  }
}
