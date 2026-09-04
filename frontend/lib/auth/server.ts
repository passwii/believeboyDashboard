import type { Session } from 'next-auth'

import { auth } from '@/lib/auth/options'

// ── JWT Session Cache ─────────────────────────────────────────────────────
// 同一用户同一 JWT cookie 在 5 分钟内只解密一次。
// Next.js Route Handler 运行在同一 Node.js 进程，Map 可跨请求共享。
// 省去每次请求都执行 HKDF-SHA256 + AES-256-CBC + HMAC-SHA-512 解密链。
const SESSION_CACHE_MAX = 128
const SESSION_CACHE_TTL_MS = 5 * 60 * 1000

type CacheEntry = { session: Session; ts: number }
const sessionCache = new Map<string, CacheEntry>()

function getSessionFromCache(cookieValue: string): Session | null {
  const entry = sessionCache.get(cookieValue)
  if (!entry) return null
  if (Date.now() - entry.ts > SESSION_CACHE_TTL_MS) {
    sessionCache.delete(cookieValue)
    return null
  }
  return entry.session
}

function setSessionCache(cookieValue: string, session: Session): void {
  if (sessionCache.size >= SESSION_CACHE_MAX) {
    const keys = sessionCache.keys()
    for (let i = 0; i < SESSION_CACHE_MAX / 2; i++) {
      sessionCache.delete(keys.next().value!)
    }
  }
  sessionCache.set(cookieValue, { session, ts: Date.now() })
}

export async function getServerAuthSession() {
  // 从 cookies() 提取原始 JWT token 字符串用于缓存 key
  const { cookies } = await import('next/headers')
  const cookieStore = await cookies()
  // NextAuth v4 默认 cookie 名：生产 __Secure-next-auth.session-token，开发 next-auth.session-token
  const tokenCookie =
    cookieStore.get('__Secure-next-auth.session-token')?.value ??
    cookieStore.get('next-auth.session-token')?.value

  if (tokenCookie) {
    const cached = getSessionFromCache(tokenCookie)
    if (cached) return cached
  }

  const session = await auth()

  if (tokenCookie && session?.user?.id) {
    setSessionCache(tokenCookie, session)
  }

  return session
}

export async function requireUserSession() {
  const session = await getServerAuthSession()
  if (!session?.user?.id) {
    return null
  }
  return session
}

export async function requireAdminSession() {
  const session = await getServerAuthSession()
  if (!session?.user?.id || session.user.roleType !== 'admin') {
    return null
  }
  return session
}
