import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl
  const token = await getToken({ req: request, secret: process.env.NEXTAUTH_SECRET })

  if (pathname === '/login') {
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

    if (pathname.startsWith('/dashboard/system-management') && !token.isAdmin) {
      return NextResponse.redirect(new URL('/dashboard?forbidden=1', request.url))
    }
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/login', '/dashboard/:path*'],
}
