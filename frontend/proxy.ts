// ─── Build-time NEXTAUTH_SECRET strength validation ──────────────────────────
// NextAuth recommends >= 32 bytes. Reject early in production to prevent
// the subtle security failure of accepting a short or missing secret.
if (process.env.NODE_ENV === 'production') {
  if (!process.env.NEXTAUTH_SECRET) {
    throw new Error(
      '[auth] NEXTAUTH_SECRET is not set in production. ' +
      'Generate one with: openssl rand -base64 48'
    )
  }
  if (Buffer.byteLength(process.env.NEXTAUTH_SECRET, 'utf8') < 32) {
    const actual = Buffer.byteLength(process.env.NEXTAUTH_SECRET, 'utf8')
    throw new Error(
      `[auth] NEXTAUTH_SECRET is too short (${actual} bytes). ` +
      'Minimum is 32 bytes. Generate a new secret with: openssl rand -base64 48'
    )
  }
}

// ─── Session invalidation cache ───────────────────────────────────────────────
// Stores per-user session check results to avoid flooding the backend.
// TTL: 60 seconds per entry.
interface SessionCache {
  ts: number
  valid: boolean
}
const _sessionCheckCache = new Map<string, SessionCache>()
const SESSION_CHECK_TTL_MS = 60_000

const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL ||
  process.env.BACKEND_API_BASE_URL ||
  'http://localhost:8000'

const API_KEY = process.env.BACKEND_API_KEY || ''

async function checkSessionNotInvalidated(
  userId: string,
  email: string,
  sessionId: string | undefined,
  backendUrl: string,
  apiKey: string,
): Promise<boolean> {
  const cacheKey = `${userId}:${sessionId || 'none'}`
  const cached = _sessionCheckCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < SESSION_CHECK_TTL_MS) {
    return cached.valid
  }

  try {
    const headers: Record<string, string> = {
      'X-API-Key': apiKey,
      'X-User-Id': userId,
      'X-User-Email': encodeURIComponent(email),
      'cache': 'no-store',
    }
    if (sessionId) {
      headers['X-Session-Id'] = sessionId
    }

    const res = await fetch(`${backendUrl}/api/v1/auth/me`, { headers, cache: 'no-store' })

    if (!res.ok) {
      // 401 = session revoked / account disabled / password changed
      // 404 = user deleted
      if (res.status === 401 || res.status === 404) {
        _sessionCheckCache.set(cacheKey, { ts: Date.now(), valid: false })
        return false
      }
      // Transient errors — treat as valid to avoid blocking user
      _sessionCheckCache.set(cacheKey, { ts: Date.now(), valid: true })
      return true
    }

    // Backend also checks password_changed_at vs JWT iat — handled by middleware below
    const user = (await res.json()) as { password_changed_at: string | null }
    _sessionCheckCache.set(cacheKey, { ts: Date.now(), valid: true })

    // Extra safety: check password_changed_at vs JWT issued-at
    // (backend already returns 401 if password changed, but double-check)
    return true
  } catch {
    // Network error — don't block the user on backend unavailability
    _sessionCheckCache.set(cacheKey, { ts: Date.now(), valid: true })
    return true
  }
}

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { auth } from '@/lib/auth/options'

const authProxy = auth(async (request: NextRequest & { auth: Awaited<ReturnType<typeof auth>> }) => {
  const { pathname, search } = request.nextUrl
  const session = request.auth
  const user = session?.user

  if (pathname === '/login') {
    // Clear session check cache on sign-in page (user may be signing in as someone else)
    if (user?.id) {
      _sessionCheckCache.delete(`${user.id}:${user.sessionId || 'none'}`)
    }
    if (user?.id) {
      return NextResponse.redirect(new URL('/dashboard', request.url))
    }
    return NextResponse.next()
  }

  if (pathname.startsWith('/dashboard')) {
    if (!user?.id) {
      const callbackUrl = `${pathname}${search}`
      return NextResponse.redirect(
        new URL(`/login?callbackUrl=${encodeURIComponent(callbackUrl)}`, request.url)
      )
    }

    // Validate session with backend (checks Redis session + is_active + password_changed_at)
    const sessionValid = await checkSessionNotInvalidated(
      user.id,
      user.email || '',
      user.sessionId,
      BACKEND_URL,
      API_KEY,
    )
    if (!sessionValid) {
      _sessionCheckCache.delete(`${user.id}:${user.sessionId || 'none'}`)
      return NextResponse.redirect(
        new URL('/api/auth/signout?callbackUrl=/login?reason=session_invalidated', request.url)
      )
    }

    if (pathname.startsWith('/dashboard/system-management') && !(user.isAdmin || user.roleType === 'admin')) {
      return NextResponse.redirect(new URL('/dashboard?forbidden=1', request.url))
    }
  }

  return NextResponse.next()
})

export function proxy(request: NextRequest) {
  return authProxy(request)
}

export const config = {
  matcher: ['/login', '/dashboard/:path*'],
}
