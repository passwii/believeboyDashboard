'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { signOut, useSession } from 'next-auth/react'
import { SearchCommand } from '@/components/dashboard/search-command'
import {
  getWarmLedgerPageTitle,
  isWarmLedgerRoute,
  isWarmLedgerStandaloneRoute,
  WarmLedgerRouteFrame,
} from '@/components/dashboard-v2/warm-ledger/shell/warm-ledger-route-frame'
import { TerminalHeaderSlotProvider } from '@/components/terminal/terminal-header-slot'
import { ServerNotificationsProvider } from '@/components/notifications/server-notifications-context'
import { buildLoginCallbackUrl } from '@/lib/login-callback-url'

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<div data-dashboard-layout-loading aria-busy="true" />}>
      <DashboardLayoutContent>{children}</DashboardLayoutContent>
    </Suspense>
  )
}

function DashboardLayoutContent({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const isWarmLedgerHome = pathname === '/dashboard'
  const isWarmLedger = isWarmLedgerRoute(pathname, searchParams)
  const isWarmStandalone = isWarmLedgerStandaloneRoute(pathname, searchParams)
  const pageTitle = useMemo(() => getWarmLedgerPageTitle(pathname), [pathname])
  const { status } = useSession()
  const wasAuthenticatedRef = useRef(false)

  const getCurrentPath = useCallback(
    () => `${window.location.pathname}${window.location.search}`,
    []
  )

  useEffect(() => {
    if (status === 'authenticated') {
      wasAuthenticatedRef.current = true
      return
    }

    if (status === 'unauthenticated' && wasAuthenticatedRef.current) {
      void signOut({ callbackUrl: buildLoginCallbackUrl(getCurrentPath()) })
    }
  }, [getCurrentPath, status])

  useEffect(() => {
    document.title = `${pageTitle} | BelieveBoy Dashboard`
  }, [pageTitle])

  // 监听全局登出事件。
  useEffect(() => {
    const handler = () => {
      void signOut({ callbackUrl: buildLoginCallbackUrl(getCurrentPath()) })
    }
    window.addEventListener('believeboy:logout', handler)
    return () => window.removeEventListener('believeboy:logout', handler)
  }, [getCurrentPath])

  // 主内容区在自定义滚动容器 #main-content 内（非 window），document 不滚动，
  // 浏览器默认“刷新回到顶部”只作用于 document，对该容器不生效；Chrome 还会在
  // 刷新后恢复该容器的旧位置。这里在路由变化与 load 事件后强制滚回顶部。
  // behavior 用 instant：全局 html 设了 scroll-behavior:smooth，避免复位变成动画。
  useEffect(() => {
    const reset = () =>
      document.getElementById('main-content')?.scrollTo({ top: 0, behavior: 'instant' })
    reset()
    window.addEventListener('load', reset)
    return () => window.removeEventListener('load', reset)
  }, [pathname])

  return (
    <ServerNotificationsProvider>
      {isWarmStandalone ? (
        <TerminalHeaderSlotProvider>
          <div
            className="warm-ledger min-h-dvh bg-[var(--warm-ledger-color-stage)] text-[var(--warm-ledger-color-text)]"
            data-testid="warm-standalone"
          >
            {children}
            <SearchCommand />
          </div>
        </TerminalHeaderSlotProvider>
      ) : isWarmLedger ? (
        <WarmLedgerRouteFrame pathname={pathname}>{children}</WarmLedgerRouteFrame>
      ) : isWarmLedgerHome ? (
        <>
          {children}
          <SearchCommand />
        </>
      ) : (
        <WarmLedgerRouteFrame pathname={pathname}>{children}</WarmLedgerRouteFrame>
      )}
    </ServerNotificationsProvider>
  )
}
