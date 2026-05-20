'use client'

import { useEffect, useMemo, useState } from 'react'
import { usePathname } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { LivePresence } from '@/components/dashboard/live-presence'
import { DashboardPageLoading } from '@/components/dashboard/dashboard-page-loading'
import { RecentPagesDropdown } from '@/components/dashboard/recent-pages-dropdown'
import { RouteLoadingLink } from '@/components/dashboard/route-loading-link'
import { NotificationPanel, useNotifications } from '@/components/notifications'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { DashboardAISidebarProvider } from '@/components/dashboard/ai-sidebar-bridge'
import { AppSidebar } from '@/components/dashboard/app-sidebar'
import {
  ALL_ITEMS,
  getVisibleItems,
  useSidebarPinnedItems,
  useVisiblePinnedUrls,
  PinSettingsPopover,
  MAX_PINNED,
} from '@/components/dashboard/sidebar-pin-settings'
import { Button } from '@/components/ui/button'
import { ThemeToggle } from '@/components/theme-toggle'
import { getDashboardPageTitle } from '@/lib/dashboard-route-meta'
import { useRecentPages } from '@/lib/recent-pages'
import { useGlobalLoading } from '@/components/global-loading-provider'
import {
  Bell,
  BookOpen,
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Settings,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

function getDashboardBreadcrumbLabel(pathname: string, pageTitle: string) {
  if (pathname === '/dashboard') return '运营总览'

  if (pathname.includes('/data-reporting/')) return `运营核算 > ${pageTitle}`
  if (pathname.includes('/data-analysis/')) return `数据分析 > ${pageTitle}`
  if (pathname.includes('/data-management/')) return `数据管理 > ${pageTitle}`
  if (pathname.includes('/system-management/')) return `系统管理 > ${pageTitle}`
  if (pathname.includes('/operations/')) return `运营导航 > ${pageTitle}`
  if (pathname.includes('/ai-panel/')) return `AI 面板 > ${pageTitle}`
  if (pathname.includes('/ai-insights')) return `AI 面板 > ${pageTitle}`

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

function DesktopPinnedItems() {
  const { data: session } = useSession()
  const { pinnedUrls, toggle } = useSidebarPinnedItems()
  const roleType = session?.user?.roleType
  const visiblePinnedUrls = useVisiblePinnedUrls(pinnedUrls, roleType)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const visibleItems = getVisibleItems(roleType)
  const visibleUrlsSet = new Set(visiblePinnedUrls)

  // iPad (lg): 4 icons + overflow; xl: 3 icons + overflow
  const displayCount = Math.min(visiblePinnedUrls.length, 3)
  const hasMore = visiblePinnedUrls.length > displayCount
  const moreUrls = visiblePinnedUrls.slice(displayCount)

  return (
    <div className="hidden items-center lg:flex">
      {visiblePinnedUrls.slice(0, displayCount).map((url) => {
        const item = ALL_ITEMS.find((i) => i.url === url)
        if (!item) return null
        return (
          <RouteLoadingLink
            key={url}
            href={url}
            className="flex h-10 w-10 items-center justify-center rounded-xl border border-transparent bg-transparent text-secondary transition-colors hover:bg-[hsl(var(--surface-subtle))] hover:text-foreground"
            title={item.title}
          >
            {item.icon}
          </RouteLoadingLink>
        )
      })}

      {hasMore && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-10 w-10 rounded-xl border border-transparent bg-transparent text-secondary hover:bg-[hsl(var(--surface-subtle))]"
              aria-label="更多快捷入口"
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {moreUrls.map((url) => {
              const item = ALL_ITEMS.find((i) => i.url === url)
              if (!item) return null
              return (
                <DropdownMenuItem key={url} asChild>
                  <RouteLoadingLink href={url} className="flex w-full items-center gap-2">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-border/60 bg-muted/60 text-muted-foreground">
                      {item.icon}
                    </span>
                    <span className="truncate">{item.title}</span>
                  </RouteLoadingLink>
                </DropdownMenuItem>
              )
            })}
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <PinSettingsPopover
                pinnedUrls={pinnedUrls}
                onToggle={toggle}
                roleType={roleType}
                trigger={
                  <button className="flex w-full cursor-pointer items-center gap-2 px-2 py-1.5 text-sm">
                    <Settings className="h-4 w-4" />
                    <span>管理快捷入口</span>
                  </button>
                }
              />
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {!hasMore && (
        <PinSettingsPopover
          pinnedUrls={pinnedUrls}
          onToggle={toggle}
          roleType={roleType}
          trigger={
            <Button
              variant="ghost"
              size="icon"
              className="h-10 w-10 rounded-xl border border-transparent bg-transparent text-secondary hover:bg-[hsl(var(--surface-subtle))]"
              aria-label="管理快捷入口"
            >
              <Settings className="h-4 w-4" />
            </Button>
          }
        />
      )}
    </div>
  )
}

function MobilePinnedItems() {
  const { data: session } = useSession()
  const { pinnedUrls, toggle } = useSidebarPinnedItems()
  const roleType = session?.user?.roleType
  const visiblePinnedUrls = useVisiblePinnedUrls(pinnedUrls, roleType)

  const visibleItems = getVisibleItems(roleType)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9 shrink-0 rounded-xl border-border/65 bg-[hsl(var(--surface-subtle))] shadow-none sm:h-10 sm:w-10"
          aria-label="快捷入口"
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {visiblePinnedUrls.length === 0 ? (
          <div className="px-4 py-3 text-center text-sm text-muted-foreground">
            暂无快捷入口
          </div>
        ) : (
          visiblePinnedUrls.map((url) => {
            const item = ALL_ITEMS.find((i) => i.url === url)
            if (!item) return null
            return (
              <DropdownMenuItem key={url} asChild>
                <RouteLoadingLink href={url} className="flex w-full items-center gap-2.5">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-border/60 bg-muted/60 text-muted-foreground">
                    {item.icon}
                  </span>
                  <span className="truncate text-[0.9rem]">{item.title}</span>
                </RouteLoadingLink>
              </DropdownMenuItem>
            )
          })
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <PinSettingsPopover
            pinnedUrls={pinnedUrls}
            onToggle={toggle}
            roleType={roleType}
            trigger={
              <button className="flex w-full cursor-pointer items-center gap-2.5 px-2 py-2 text-sm">
                <Settings className="h-4 w-4" />
                <span>管理快捷入口</span>
              </button>
            }
          />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <DashboardLayoutInner>{children}</DashboardLayoutInner>
}

function DashboardLayoutInner({
  children,
}: {
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const { isNavigationLoading } = useGlobalLoading()
  const isAiChatPage = pathname === '/dashboard/ai-panel/chat'
  const isAiChatRoute = pathname === '/dashboard/ai-panel/chat'
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [iconsExpanded, setIconsExpanded] = useState(false)
  const pageTitle = useMemo(() => getDashboardPageTitle(pathname), [pathname])
  const { pushPage } = useRecentPages()

  const breadcrumbLabel = useMemo(
    () => getDashboardBreadcrumbLabel(pathname, pageTitle),
    [pathname, pageTitle]
  )

  useEffect(() => {
    document.title = `${pageTitle} | BelieveBoy Dashboard`
  }, [pageTitle])

  useEffect(() => {
    if (pathname && pathname !== '/dashboard') {
      pushPage(pathname, pageTitle)
    }
  }, [pathname, pageTitle, pushPage])

  return (
    <DashboardAISidebarProvider>
      <SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen}>
        <AppSidebar variant="sidebar" aiChatMode={isAiChatRoute} />
        <SidebarInset className="min-h-screen min-w-0 overflow-x-clip overflow-y-auto bg-[hsl(var(--surface-low))]">
          <header className="sticky top-0 z-20 border-b border-border/70 bg-[hsl(var(--surface-overlay)/0.82)] backdrop-blur-xl">
            <div className="flex min-h-[4.5rem] items-center gap-2 px-2 sm:gap-3 md:px-5 lg:px-6 xl:gap-4 xl:px-8">
              <SidebarTrigger className="h-9 w-9 shrink-0 rounded-xl border border-border/65 bg-[hsl(var(--surface-overlay)/0.65)] text-secondary shadow-none hover:bg-[hsl(var(--surface-subtle))] sm:h-10 sm:w-10" />
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

              {/* Desktop icons toolbar — shows on lg (iPad) and above */}
              <div className="hidden items-center justify-end gap-2 lg:flex">
                <DesktopPinnedItems />
                <LivePresence />
                <div className="flex items-center justify-end gap-2">
                  <ThemeToggle />
                  <NotificationBell />
                  <RecentPagesDropdown />
                  <Button
                    asChild
                    variant="ghost"
                    size="icon"
                    className="h-10 w-10 rounded-xl border border-transparent bg-transparent text-secondary hover:bg-[hsl(var(--surface-subtle))]"
                  >
                    <RouteLoadingLink href="/dashboard/changelog" aria-label="帮助与功能说明">
                      <BookOpen className="h-4 w-4" />
                      <span className="sr-only">Help</span>
                    </RouteLoadingLink>
                  </Button>
                </div>
              </div>

              {/* Mobile: only on screens smaller than lg (iPad) */}
              <div className="flex items-center justify-end gap-1.5 lg:hidden">
                <MobilePinnedItems />
                <Button
                  variant="outline"
                  size="icon"
                  className="h-9 w-9 shrink-0 rounded-xl border-border/65 bg-[hsl(var(--surface-subtle))] shadow-none sm:h-10 sm:w-10"
                  onClick={() => setIconsExpanded((v) => !v)}
                  aria-label={iconsExpanded ? '收起工具栏' : '展开工具栏'}
                >
                  {iconsExpanded ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <MoreHorizontal className="h-4 w-4" />
                  )}
                </Button>
                <RecentPagesDropdown />
              </div>
            </div>

            {/* Mobile expanded icons toolbar — only on screens smaller than lg (iPad) */}
            <div
              className={`lg:hidden overflow-hidden border-t border-border/60 bg-[hsl(var(--surface-overlay)/0.92)] backdrop-blur-xl transition-all duration-200 ease-out ${
                iconsExpanded
                  ? 'max-h-24 opacity-100'
                  : 'max-h-0 opacity-0'
              }`}
            >
              <div className="flex items-center justify-end gap-2 px-2 py-2.5">
                <ThemeToggle />
                <NotificationBell />
                <Button
                  asChild
                  variant="ghost"
                  size="icon"
                  className="h-10 w-10 rounded-xl border border-transparent bg-transparent text-secondary hover:bg-[hsl(var(--surface-subtle))]"
                >
                  <RouteLoadingLink href="/dashboard/changelog" aria-label="帮助与功能说明">
                    <BookOpen className="h-4 w-4" />
                    <span className="sr-only">帮助</span>
                  </RouteLoadingLink>
                </Button>
              </div>
            </div>
          </header>
          <main
            id="main-content"
            className={
              isAiChatPage
                ? 'dashboard-full-width relative min-w-0 flex-1 overflow-x-clip overflow-y-auto px-0 pb-0 pt-0'
                : 'dashboard-full-width relative min-w-0 flex-1 overflow-x-clip overflow-y-auto px-1 pb-6 pt-4 md:px-2 md:pb-8 lg:px-3 xl:px-4'
            }
          >
            <div
              className={
                isAiChatPage
                  ? 'dashboard-page-shell h-[calc(100vh-4.5rem)] min-h-0 px-0 py-0'
                  : 'dashboard-page-shell min-h-0 md:min-h-[calc(100vh-8.5rem)] px-0 py-1'
              }
            >
              {isNavigationLoading ? <DashboardPageLoading /> : children}
            </div>
          </main>
        </SidebarInset>
      </SidebarProvider>
    </DashboardAISidebarProvider>
  )
}
