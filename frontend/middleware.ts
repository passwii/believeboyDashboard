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
  passwordChangedAt: string | null
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
  iat: number | undefined,
  backendUrl: string,
  apiKey: string,
): Promise<boolean> {
  const cacheKey = userId
  const cached = _sessionCheckCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < SESSION_CHECK_TTL_MS) {
    if (!cached.valid) return false
    // Re-check if password_changed_at is newer than the JWT issued-at
    if (cached.passwordChangedAt && iat !== undefined) {
      const pwdChangedSec = new Date(cached.passwordChangedAt).getTime() / 1000
      if (pwdChangedSec > iat) return false
    }
    return true
  }

  try {
    const res = await fetch(`${backendUrl}/api/v1/auth/me`, {
      headers: {
        'X-API-Key': apiKey,
        'X-User-Id': userId,
        'X-User-Email': encodeURIComponent(email),
      },
      cache: 'no-store',
    })
    if (!res.ok) {
      // Cannot verify — treat as valid to avoid blocking on transient errors
      _sessionCheckCache.set(cacheKey, { ts: Date.now(), valid: true, passwordChangedAt: null })
      return true
    }
    const user = (await res.json()) as { password_changed_at: string | null }

    if (user.password_changed_at && iat !== undefined) {
      const pwdChangedSec = new Date(user.password_changed_at).getTime() / 1000
      if (pwdChangedSec > iat) {
        _sessionCheckCache.set(cacheKey, { ts: Date.now(), valid: false, passwordChangedAt: user.password_changed_at })
        return false
      }
    }
    _sessionCheckCache.set(cacheKey, { ts: Date.now(), valid: true, passwordChangedAt: user.password_changed_at })
    return true
  } catch {
    // Network error — don't block the user on backend unavailability
    return true
  }
}

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl
  const token = await getToken({ req: request, secret: process.env.NEXTAUTH_SECRET })

  if (pathname === '/login') {
    // Clear session check cache on sign-in page (user may be signing in as someone else)
    if (token?.sub) {
      _sessionCheckCache.delete(token.sub)
    }
    if (token) {
      return NextResponse.redirect(new URL('/dashboard', request.url))
    }
    return NextResponse.next()
  }

  if (pathname.startsWith('/dashboard')) {
    if (!token) {
      const callbackUrl = `${pathname}${search}`
      return NextResponse.redirect(
        new URL(`/login?callbackUrl=${encodeURIComponent(callbackUrl)}`, request.url)
      )
    }

    // Check if session was invalidated by a password change
    const sessionValid = await checkSessionNotInvalidated(
      token.sub || '',
      token.email || '',
      token.iat as number | undefined,
      BACKEND_URL,
      API_KEY,
    )
    if (!sessionValid) {
      _sessionCheckCache.delete(token.sub || '')
      return NextResponse.redirect(
        new URL('/api/auth/signout?callbackUrl=/login?reason=session_invalidated', request.url)
      )
    }

    if (pathname.startsWith('/dashboard/system-management') && !(token.isAdmin || token.roleType === 'admin')) {
      return NextResponse.redirect(new URL('/dashboard?forbidden=1', request.url))
    }
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/login', '/dashboard/:path*'],
}
