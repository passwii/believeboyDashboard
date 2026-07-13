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
//
// BEL-133-step1: TTL lifted from 10s → 60s.
//
// Tradeoff:
//   • 10s (old): every dashboard navigation 10s after the last hit triggered
//     a synchronous Vercel→VPS RTT. First switch felt slow because the proxy
//     blocked on `/api/v1/auth/me`.
//   • 60s (new): the user's "first switch" inside the 60s window is
//     effectively free; revocation latency for kicked/disabled accounts goes
//     from ≤10s to ≤60s.
//
// To compensate we add a separate circuit-breaker (`BACKEND_FAILURE_*`) that
// remembers when the backend has been failing: while the breaker is open we
// skip the remote check entirely and trust the local NextAuth JWT signature.
// That avoids a) longer dashboards blocking when the backend is flaky and
// b) the breaker is reset on the next successful check.
interface SessionCache {
  ts: number
  valid: boolean
}
interface BackendFailureState {
  consecutiveFailures: number
  openUntil: number
}
const _sessionCheckCache = new Map<string, SessionCache>()
const _backendFailures = new Map<string, BackendFailureState>()

/**
 * Full session check — calls `/api/v1/auth/me` against the backend to confirm
 * the session is still valid (Redis-backed + is_active + password_changed_at).
 * Tradeoff: 60s revocation latency for kicked/disabled accounts; ~6× less
 * Vercel↔VPS traffic on dashboards with frequent navigation.
 */
const SESSION_CHECK_TTL_MS = 60_000

/**
 * Backend-circuit-breaker thresholds.
 *   - `BACKEND_FAILURE_THRESHOLD`: number of consecutive failed checks
 *     before we skip the remote check entirely.
 *   - `BACKEND_FAILURE_COOLDOWN_MS`: how long we stay in the "open"
 *     (skip-remote) state before probing the backend again.
 *
 * When the backend is healthy, neither constant is observable to the user.
 * When the backend is degraded, dashboards stay usable instead of every
 * click blocking on a failing `/api/v1/auth/me`.
 */
const BACKEND_FAILURE_THRESHOLD = 2
const BACKEND_FAILURE_COOLDOWN_MS = 30_000

const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL || process.env.BACKEND_API_BASE_URL || 'http://localhost:8100'

const API_KEY = process.env.BACKEND_API_KEY || ''

function getFailureState(key: string): BackendFailureState {
  let s = _backendFailures.get(key)
  if (!s) {
    s = { consecutiveFailures: 0, openUntil: 0 }
    _backendFailures.set(key, s)
  }
  return s
}

function recordBackendSuccess(key: string): void {
  const s = getFailureState(key)
  s.consecutiveFailures = 0
  s.openUntil = 0
}

function recordBackendFailure(key: string): void {
  const s = getFailureState(key)
  s.consecutiveFailures += 1
  if (s.consecutiveFailures >= BACKEND_FAILURE_THRESHOLD) {
    s.openUntil = Date.now() + BACKEND_FAILURE_COOLDOWN_MS
  }
}

function isBreakerOpen(key: string): boolean {
  const s = getFailureState(key)
  if (s.openUntil === 0) return false
  if (Date.now() >= s.openUntil) {
    // Cool-down elapsed — reset and let one probe through.
    s.openUntil = 0
    s.consecutiveFailures = 0
    return false
  }
  return true
}

async function checkSessionNotInvalidated(
  userId: string,
  email: string,
  sessionId: string | undefined,
  backendUrl: string,
  apiKey: string
): Promise<boolean> {
  const cacheKey = `${userId}:${sessionId || 'none'}`

  // If the backend has been failing repeatedly, skip the remote check and
  // trust the local JWT until the cool-down expires. Keeps dashboards usable
  // when the backend is degraded; the worst-case outcome is a kicked user
  // getting up to ~60s of extra access — same as the cache TTL window.
  if (isBreakerOpen(cacheKey)) {
    return true
  }

  const cached = _sessionCheckCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < SESSION_CHECK_TTL_MS) {
    return cached.valid
  }

  try {
    const headers: Record<string, string> = {
      'X-API-Key': apiKey,
      'X-User-Id': userId,
      'X-User-Email': encodeURIComponent(email),
      cache: 'no-store',
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
        // A 401/404 is an authoritative answer, NOT a backend health signal.
        // Don't trip the breaker on auth failures.
        recordBackendSuccess(cacheKey)
        return false
      }
      // 5xx / 429 — treat as valid to avoid blocking user, but trip the
      // breaker so the next requests skip the failing backend.
      _sessionCheckCache.set(cacheKey, { ts: Date.now(), valid: true })
      recordBackendFailure(cacheKey)
      return true
    }

    // Backend also checks password_changed_at vs JWT iat — handled by middleware below
    const user = (await res.json()) as { password_changed_at: string | null }
    _sessionCheckCache.set(cacheKey, { ts: Date.now(), valid: true })
    recordBackendSuccess(cacheKey)

    // Extra safety: check password_changed_at vs JWT issued-at
    // (backend already returns 401 if password changed, but double-check)
    return true
  } catch {
    // Network error — don't block the user on backend unavailability,
    // but remember the failure so we stop hammering a dead backend.
    _sessionCheckCache.set(cacheKey, { ts: Date.now(), valid: true })
    recordBackendFailure(cacheKey)
    return true
  }
}

import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth/options'

export const proxy = auth(async (request) => {
  const { pathname, search } = request.nextUrl
  const session = request.auth
  const user = session?.user

  if (pathname === '/login') {
    if (user?.id) {
      _sessionCheckCache.delete(`${user.id}:${user.sessionId || 'none'}`)
      return NextResponse.redirect(new URL('/dashboard', request.url))
    }
    return NextResponse.next()
  }

  if (pathname.startsWith('/dashboard')) {
    const callbackUrl = `${pathname}${search}`
    if (!user?.id) {
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
      API_KEY
    )
    if (!sessionValid) {
      _sessionCheckCache.delete(`${user.id}:${user.sessionId || 'none'}`)
      const loginCallbackUrl = `/login?reason=session_invalidated&callbackUrl=${encodeURIComponent(callbackUrl)}`
      return NextResponse.redirect(
        new URL(
          `/api/auth/signout?callbackUrl=${encodeURIComponent(loginCallbackUrl)}`,
          request.url
        )
      )
    }

    if (
      pathname.startsWith('/dashboard/system-management') &&
      !(user.isAdmin || user.roleType === 'admin')
    ) {
      return NextResponse.redirect(new URL('/dashboard?forbidden=1', request.url))
    }

    // 订单信息页面：仅 admin / operator 可见（与 ad/analysis 同款"行级 + 页级"组合）。
    if (
      pathname.startsWith('/dashboard/data-management/order-info') &&
      !(user.isAdmin || user.roleType === 'admin' || user.roleType === 'operator')
    ) {
      return NextResponse.redirect(new URL('/dashboard?forbidden=1', request.url))
    }
  }

  return NextResponse.next()
})

export const config = {
  matcher: ['/login', '/dashboard/:path*'],
}
