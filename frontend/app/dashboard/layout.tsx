'use client'

import { useEffect, useMemo, useState } from 'react'
import { usePathname } from 'next/navigation'
import { useSession, signOut } from 'next-auth/react'
import { LivePresence } from '@/components/dashboard/live-presence'
import { DashboardPageLoading } from '@/components/dashboard/dashboard-page-loading'
import { RouteLoadingLink } from '@/components/dashboard/route-loading-link'
import { NotificationPanel, useNotifications } from '@/components/notifications'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { SidebarShell } from '@/components/dashboard/sidebar-shell'
import { Button } from '@/components/ui/button'
import { getDashboardPageTitle } from '@/lib/dashboard-route-meta'
import { useRecentPages } from '@/lib/recent-pages'
import { useGlobalLoading } from '@/components/global-loading-provider'
import { Bell, BookOpen, ChevronRight, PanelLeft } from 'lucide-react'
import { cn } from '@/lib/utils'

function getDashboardBreadcrumbLabel(pathname: string, pageTitle: string) {
 if (pathname === '/dashboard') return '运营总览'

 if (pathname.includes('/data-reporting/')) return `运营核算 > ${pageTitle}`
 if (pathname.includes('/data-analysis/')) return `数据分析 > ${pageTitle}`
 if (pathname.includes('/data-management/')) return `数据管理 > ${pageTitle}`
 if (pathname.includes('/system-management/')) return `系统管理 > ${pageTitle}`
 if (pathname.includes('/operations/')) return `运营导航 > ${pageTitle}`
 if (pathname.includes('/ai-chat')) return `AI面板 > ${pageTitle}`
 if (pathname.includes('/ai/ad-analysis')) return `AI面板 > ${pageTitle}`
 if (pathname.includes('/ai-insights')) return `AI面板 > ${pageTitle}`
 if (pathname.includes('/ai')) return `AI面板 > ${pageTitle}`
 if (pathname.includes('/business-dev/')) return `特殊功能 > ${pageTitle}`
 if (pathname.includes('/digital-employees')) return `特殊功能 > ${pageTitle}`

 return pageTitle
}

function NotificationBell() {
 const { unreadCount } = useNotifications()
 const [panelOpen, setPanelOpen] = useState(false)

 const badgeLabel = useMemo(() => {
 if (unreadCount <=0) return null
 return unreadCount >9 ? '9+' : String(unreadCount)
 }, [unreadCount])

 return (
 <>
 <Button
 variant='ghost'
 size='icon'
 className='relative h-10 w-10 rounded-xl border border-transparent bg-transparent text-secondary hover:bg-[hsl(var(--surface-subtle))]'
 onClick={() => setPanelOpen(true)}
 aria-label='打开通知中心'
 >
 <Bell className='h-4 w-4' />
 {badgeLabel ? (
 <span className='absolute right-1.5 top-1.5 inline-flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[0.62rem] font-semibold leading-4 text-primary-foreground shadow-sm'>
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
 const { isNavigationLoading } = useGlobalLoading()
 const pageTitle = useMemo(() => getDashboardPageTitle(pathname), [pathname])
 const { pushPage } = useRecentPages()

 const breadcrumbLabel = useMemo(
 () => getDashboardBreadcrumbLabel(pathname, pageTitle),
 [pathname, pageTitle],
 )

 useEffect(() => {
 document.title = `${pageTitle} | BelieveBoy Dashboard`
 }, [pageTitle])

 useEffect(() => {
 if (pathname && pathname !== '/dashboard') {
 pushPage(pathname, pageTitle)
 }
 }, [pathname, pageTitle, pushPage])

 //监听 SidebarShell派发的登出事件
 useEffect(() => {
 const handler = () => {
 void signOut({ callbackUrl: '/login' })
 }
 window.addEventListener('believeboy:logout', handler)
 return () => window.removeEventListener('believeboy:logout', handler)
 }, [])

 return (
 <SidebarProvider>
 <div className='flex h-screen w-full overflow-hidden bg-[hsl(var(--surface-low))]'>
 <SidebarShell />

 {/* Main content area — pushed right when sidebar panel is open via parent flex layout */}
 <SidebarInset className='flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[hsl(var(--surface-low))]'>
 <header className='sticky top-0 z-20 shrink-0 border-b border-border/70 bg-[hsl(var(--surface-overlay)/0.82)] backdrop-blur-xl'>
 <div className='flex min-h-[4.5rem] items-center gap-2 px-2 sm:gap-3 md:px-5 lg:px-6 xl:gap-4 xl:px-8'>
 <Button
 asChild
 variant='ghost'
 size='icon'
 className='h-9 w-9 shrink-0 rounded-xl border border-border/65 bg-[hsl(var(--surface-overlay)/0.65)] text-secondary shadow-none hover:bg-[hsl(var(--surface-subtle))] sm:h-10 sm:h-10 md:hidden'
 aria-label='打开导航菜单'
 >
 <span>
 <PanelLeft className='h-4 w-4' />
 </span>
 </Button>
 <div className='min-w-0 flex-1'>
 <nav className='flex items-center gap-1.5 overflow-hidden text-[1rem] font-medium text-muted-foreground md:text-[1.08rem]'>
 {breadcrumbLabel.split(' > ').map((segment, index, items) => (
 <span key={`${segment}-${index}`} className='inline-flex min-w-0 items-center gap-1.5'>
 {index >0 ? <ChevronRight className='h-4 w-4 shrink-0 text-muted-foreground/70' /> : null}
 <span
 className={
 index === items.length -1
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

 {/* Desktop toolbar — keeps presence + notifications + help */}
 <div className='hidden items-center justify-end gap-2 lg:flex'>
 <LivePresence />
 <NotificationBell />
 <Button
 asChild
 variant='ghost'
 size='icon'
 className='h-10 w-10 rounded-xl border border-transparent bg-transparent text-secondary hover:bg-[hsl(var(--surface-subtle))]'
 >
 <RouteLoadingLink href='/dashboard/changelog' aria-label='帮助与功能说明'>
 <BookOpen className='h-4 w-4' />
 <span className='sr-only'>Help</span>
 </RouteLoadingLink>
 </Button>
 </div>

 {/* Mobile toolbar */}
 <div className='flex items-center justify-end gap-1.5 lg:hidden'>
 <NotificationBell />
 <Button
 asChild
 variant='ghost'
 size='icon'
 className='h-9 w-9 rounded-xl border border-transparent bg-transparent text-secondary sm:h-10 sm:w-10'
 >
 <RouteLoadingLink href='/dashboard/changelog' aria-label='帮助与功能说明'>
 <BookOpen className='h-4 w-4' />
 </RouteLoadingLink>
 </Button>
 </div>
 </div>
 </header>
 <main
 id='main-content'
 className='dashboard-full-width relative min-w-0 flex-1 overflow-x-clip overflow-y-auto px-1 pb-6 pt-4 md:px-2 md:pb-8 lg:px-3 xl:px-4'
 >
 <div className='dashboard-page-shell min-h-0 md:min-h-[calc(100vh-8.5rem)] px-0 py-1'>
 {isNavigationLoading ? <DashboardPageLoading /> : children}
 </div>
 </main>
 </SidebarInset>
 </div>
 </SidebarProvider>
 )
}
