import { DefaultSession } from 'next-auth'

declare module 'next-auth' {
  interface Session {
    user: {
      id: string
      isAdmin: boolean
      /**
       * BLF-1441：全局人物显示名唯一来源 = `user_accounts.full_name`。
       * 账号存在但没填姓名时是 `null`（展示端按「未命名」处理），
       * **不会**回落 `operatorNameZh` / `name`（登录名）。
       */
      fullName?: string | null
      operatorNameZh?: string | null
      roleType: 'admin' | 'operator' | 'businessdev'
      sessionId?: string
    } & DefaultSession['user']
  }

  interface User {
    id: string
    isAdmin: boolean
    fullName?: string | null
    operatorNameZh?: string | null
    roleType?: 'admin' | 'operator' | 'businessdev'
    sessionId?: string
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    uid?: string
    isAdmin?: boolean
    /** BLF-1441：`user_accounts.full_name` 的会话副本；`null` = 账号存在但没填姓名。 */
    fullName?: string | null
    operatorNameZh?: string | null
    roleType?: 'admin' | 'operator' | 'businessdev'
    sessionId?: string
  }
}
