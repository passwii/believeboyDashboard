import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth/options'
import {
  invalidateBackendSessionValidation,
  validateBackendSession,
} from '@/lib/auth/session-validation'

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

export const proxy = auth(async (request) => {
  const { pathname, search } = request.nextUrl
  const session = request.auth
  const user = session?.user

  if (pathname === '/login') {
    if (user?.id) {
      invalidateBackendSessionValidation(user.id, user.sessionId)
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

    const validation = await validateBackendSession(session ?? null)
    if (validation === 'unavailable') {
      return NextResponse.json(
        { message: '登录状态校验服务暂不可用，请稍后重试。' },
        { status: 503 }
      )
    }
    if (validation !== 'valid') {
      invalidateBackendSessionValidation(user.id, user.sessionId)
      const loginCallbackUrl = `/login?reason=session_invalidated&callbackUrl=${encodeURIComponent(callbackUrl)}`
      return NextResponse.redirect(
        new URL(
          `/api/auth/signout?callbackUrl=${encodeURIComponent(loginCallbackUrl)}`,
          request.url
        )
      )
    }

    if (
      pathname.startsWith('/dashboard/system') &&
      !(user.isAdmin || user.roleType === 'admin')
    ) {
      return NextResponse.redirect(new URL('/dashboard?forbidden=1', request.url))
    }

    // 订单信息页面：仅 admin / operator 可见（与 ad/analysis 同款"行级 + 页级"组合）。
    if (
      pathname.startsWith('/dashboard/reports/order-info') &&
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
