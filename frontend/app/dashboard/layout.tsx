'use client'

import { useEffect, useMemo, useState } from 'react'
import { usePathname } from 'next/navigation'
import { LivePresence } from '@/components/dashboard/live-presence'
import { DashboardPageLoading } from '@/components/dashboard/dashboard-page-loading'
import { RouteLoadingLink } from '@/components/dashboard/route-loading-link'
import { NotificationPanel, useNotifications } from '@/components/notifications'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { AppSidebar } from '@/components/dashboard/app-sidebar'
import { SearchCommand } from '@/components/dashboard/search-command'
import { Button } from '@/components/ui/button'
import { ThemeToggle } from '@/components/theme-toggle'
import { getDashboardPageTitle } from '@/lib/dashboard-route-meta'
import { useGlobalLoading } from '@/components/global-loading-provider'
import { Bell, ChevronRight, Heart, History, Search } from 'lucide-react'

function getDashboardBreadcrumbLabel(pathname: string, pageTitle: string) {
  if (pathname === '/dashboard') return '运营总览'

  if (pathname.includes('/data-reporting/')) return `运营核算 > ${pageTitle}`
  if (pathname.includes('/data-analysis/')) return `数据分析 > ${pageTitle}`
  if (pathname.includes('/data-management/')) return `数据管理 > ${pageTitle}`
  if (pathname.includes('/system-management/')) return `系统管理 > ${pageTitle}`
  if (pathname.includes('/operations/')) return `运营导航 > ${pageTitle}`
  if (pathname.includes('/ai-panel/')) return `AI 面板 > ${pageTitle}`
  if (pathname.includes('/tools/')) return `工具集 > ${pageTitle}`

  return pageTitle
}

function NotificationBell() {
  const { unreadCount } = useNotifications()
  const [panelOpen, setPanelOpen] = useState(false)

  const badgeLabel = useMemo(() => {
    if (unreadCount <= 0) return null
    return unreadCount > 9 ? '9+' : String(unreadCount)
  }, [unreadCount])

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="relative h-10 w-10 rounded-xl border border-transparent bg-transparent text-secondary hover:bg-[hsl(var(--surface-subtle))]"
        onClick={() => setPanelOpen(true)}
        aria-label="打开通知中心"
      >
        <Bell className="h-4 w-4" />
        {badgeLabel ? (
          <span className="absolute right-1.5 top-1.5 inline-flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[0.62rem] font-semibold leading-4 text-primary-foreground shadow-sm">
            {badgeLabel}
          </span>
        ) : null}
      </Button>
      <NotificationPanel open={panelOpen} onOpenChange={setPanelOpen} />
    </>
  )
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const { isNavigationLoading, navigationTargetPath } = useGlobalLoading()
  const effectivePathname = isNavigationLoading && navigationTargetPath ? navigationTargetPath : pathname
  const isAiChatPage = pathname === '/dashboard/ai-panel/chat'
  const [sidebarOpen, setSidebarOpen] = useState(true)

  // Navigate to AI chat page → auto-collapse sidebar
  useEffect(() => {
    if (isAiChatPage) {
      setSidebarOpen(false)
    } else {
      setSidebarOpen(true)
    }
  }, [isAiChatPage])
  const pageTitle = useMemo(() => getDashboardPageTitle(effectivePathname), [effectivePathname])
  const breadcrumbLabel = useMemo(
    () => getDashboardBreadcrumbLabel(effectivePathname, pageTitle),
    [effectivePathname, pageTitle]
  )

  useEffect(() => {
    document.title = `${pageTitle} | BelieveBoy Dashboard`
  }, [pageTitle])

  return (
    <SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen}>
      <AppSidebar variant="sidebar" />
      <SidebarInset className="min-w-0 overflow-x-clip bg-[hsl(var(--surface-low))]">
        <header className="sticky top-0 z-20 border-b border-border/70 bg-[hsl(var(--surface-overlay)/0.82)] backdrop-blur-xl">
          <div className="flex min-h-[4.5rem] items-center gap-4 px-3 md:px-5 lg:px-6 xl:px-8">
            <SidebarTrigger className="h-10 w-10 rounded-xl border border-border/65 bg-[hsl(var(--surface-overlay)/0.65)] text-secondary shadow-none hover:bg-[hsl(var(--surface-subtle))]" />
            <div className="min-w-0 flex-1">
              <nav className="flex items-center gap-1.5 overflow-hidden text-[1rem] font-medium text-muted-foreground md:text-[1.08rem]">
                {breadcrumbLabel.split(' > ').map((segment, index, items) => (
                  <span key={`${segment}-${index}`} className="inline-flex min-w-0 items-center gap-1.5">
                    {index > 0 ? <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/70" /> : null}
                    <span
                      className={
                        index === items.length - 1
                          ? 'truncate text-[1.22rem] font-semibold tracking-tight text-foreground md:text-[1.4rem]'
                          : 'truncate text-[1.02rem] font-medium text-foreground/72 md:text-[1.08rem]'
                      }
                    >
                      {segment}
                    </span>
                  </span>
                ))}
              </nav>
            </div>
            <div className="hidden min-w-[18rem] flex-1 justify-end xl:flex">
              <Button
                variant="outline"
                className="h-10 w-full max-w-[24rem] justify-start rounded-xl border-border/65 bg-[hsl(var(--surface-subtle))] px-4 text-muted-foreground shadow-none"
                onClick={() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))}
              >
                <Search className="h-4 w-4" />
                <span className="flex-1 text-left">搜索页面、工具与报表...</span>
                <span className="rounded-sm bg-background/90 px-2 py-1 text-[0.68rem] font-semibold text-foreground/70">⌘K</span>
              </Button>
            </div>
            <LivePresence />
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="outline"
                size="icon"
                className="h-10 w-10 rounded-xl border-border/65 bg-[hsl(var(--surface-subtle))] shadow-none xl:hidden"
                onClick={() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))}
              >
                <Search className="h-4 w-4" />
                <span className="sr-only">Search</span>
              </Button>
              <ThemeToggle />
              <NotificationBell />
              <Button
                asChild
                variant="ghost"
                size="icon"
                className="h-10 w-10 rounded-xl border border-transparent bg-transparent text-secondary hover:bg-[hsl(var(--surface-subtle))]"
              >
                <RouteLoadingLink href="/dashboard/changelog" aria-label="开发更新日志">
                  <History className="h-4 w-4" />
                  <span className="sr-only">History</span>
                </RouteLoadingLink>
              </Button>
              <Button
                asChild
                variant="ghost"
                size="icon"
                className="h-10 w-10 rounded-xl border border-transparent bg-transparent text-secondary hover:bg-[hsl(var(--surface-subtle))]"
              >
                <RouteLoadingLink href="/dashboard/changelog" aria-label="帮助与功能说明">
                  <Heart className="h-4 w-4" />
                  <span className="sr-only">Help</span>
                </RouteLoadingLink>
              </Button>
            </div>
          </div>
        </header>
        <main
          id="main-content"
          className={
            isAiChatPage
              ? 'dashboard-full-width relative min-w-0 flex-1 overflow-x-clip px-0 pb-0 pt-0'
              : 'dashboard-full-width relative min-w-0 flex-1 overflow-x-clip px-1 pb-6 pt-4 md:px-2 md:pb-8 lg:px-3 xl:px-4'
          }
        >
          <div
            className={
              isAiChatPage
                ? 'dashboard-page-shell h-[calc(100vh-4.5rem)] min-h-0 px-0 py-0'
                : 'dashboard-page-shell min-h-[calc(100vh-8.5rem)] px-0 py-1'
            }
          >
            {isNavigationLoading ? <DashboardPageLoading /> : children}
          </div>
        </main>
      </SidebarInset>
      <SearchCommand />
    </SidebarProvider>
  )
}
