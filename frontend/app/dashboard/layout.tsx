'use client'

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { usePathname } from 'next/navigation'
import { signOut, useSession } from 'next-auth/react'
import { PageTransition } from '@/components/motion/PageTransition'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { SidebarShell } from '@/components/dashboard/sidebar-shell'
import { NotificationBell } from '@/components/notifications/notification-bell'
import { getDashboardPageTitle } from '@/lib/dashboard-route-meta'
import { buildLoginCallbackUrl } from '@/lib/login-callback-url'

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const pageTitle = useMemo(() => getDashboardPageTitle(pathname), [pathname])
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

  // 监听 SidebarShell 派发的登出事件
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
    <SidebarProvider>
      <NotificationBell />
      <div className="flex h-screen w-full overflow-hidden bg-[hsl(var(--surface-low))]">
        <SidebarShell />

        {/* Main content area — pushed right when sidebar panel is open via parent flex layout */}
        <SidebarInset className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[hsl(var(--surface-low))]">
          <main
            id="main-content"
            className="dashboard-full-width relative min-w-0 flex-1 overflow-x-clip overflow-y-auto px-1 pb-6 pt-3 md:px-2 md:pb-8 lg:px-3 xl:px-4"
          >
            <div className="dashboard-page-shell min-h-0 md:min-h-[calc(100vh-4rem)] px-0 py-1">
              <PageTransition>{children}</PageTransition>
            </div>
          </main>
        </SidebarInset>
      </div>
    </SidebarProvider>
  )
}
