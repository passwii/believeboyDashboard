import { DefaultSession } from 'next-auth'

declare module 'next-auth' {
  interface Session {
    user: {
      id: string
      isAdmin: boolean
      operatorNameZh?: string | null
    } & DefaultSession['user']
  }

  interface User {
    id: string
    isAdmin: boolean
    operatorNameZh?: string | null
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    uid?: string
    isAdmin?: boolean
    operatorNameZh?: string | null
  }
}
