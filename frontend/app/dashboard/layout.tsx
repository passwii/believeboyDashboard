'use client'

import { useEffect, useMemo } from 'react'
import { usePathname } from 'next/navigation'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { AppSidebar } from '@/components/dashboard/app-sidebar'
import { SearchCommand } from '@/components/dashboard/search-command'
import { Button } from '@/components/ui/button'
import { Bell, ChevronRight, CircleHelp, History, Search } from 'lucide-react'

const DASHBOARD_PAGE_TITLES: Array<{ match: string; title: string }> = [
  { match: '/data-reporting/daily-report', title: '销售日报' },
  { match: '/data-reporting/monthly-report', title: '财务月报' },
  { match: '/data-reporting/product-analysis', title: '产品分析' },
  { match: '/data-reporting/pricing-calculation', title: '定价核算' },
  { match: '/data-analysis/financial-data', title: '月度财务分析' },
  { match: '/data-analysis/daily-analysis', title: '销售数据' },
  { match: '/data-analysis/ad-analysis', title: '广告分析' },
  { match: '/data-analysis/weekly-product-analysis', title: '按周产品分析' },
  { match: '/data-analysis/inventory-analysis', title: '库存分析' },
  { match: '/data-analysis/inventory-replenishment', title: '补货分析' },
  { match: '/data-management/report-upload', title: '报表上传' },
  { match: '/data-management/shipment-management', title: '发货管理' },
  { match: '/data-management/sku-cost', title: 'SKU 信息中心' },
  { match: '/data-management/exchange-rate', title: '汇率信息' },
  { match: '/system-management/project-info', title: '项目信息' },
  { match: '/system-management/data-management', title: '数据库状态' },
  { match: '/system-management/account-management', title: '系统账号管理' },
  { match: '/system-management/commission-overview', title: '佣金管理' },
  { match: '/system-management/commission-management', title: '佣金管理' },
  { match: '/system-management/logs', title: '日志查看' },
  { match: '/operations/site-navigation', title: '跨境平台书签导航' },
  { match: '/operations/store-navigation', title: '店铺导航' },
  { match: '/ai-panel/chat', title: 'AI 聊天面板' },
  { match: '/tools/research-analysis', title: '调研分析' },
  { match: '/change-password', title: '修改密码' },
  { match: '/changelog', title: '更新日志' },
]

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const pageTitle = useMemo(() => {
    if (pathname === '/dashboard') return '运营总览与关键数据面板'
    return DASHBOARD_PAGE_TITLES.find(({ match }) => pathname.includes(match))?.title ?? 'Dashboard'
  }, [pathname])
  const breadcrumbLabel = useMemo(() => {
    if (pathname === '/dashboard') return '运营总览'

    if (pathname.includes('/data-reporting/')) return `运营核算 > ${pageTitle}`
    if (pathname.includes('/data-analysis/')) return `数据分析 > ${pageTitle}`
    if (pathname.includes('/data-management/')) return `数据管理 > ${pageTitle}`
    if (pathname.includes('/system-management/')) return `系统管理 > ${pageTitle}`
    if (pathname.includes('/operations/')) return `运营导航 > ${pageTitle}`
    if (pathname.includes('/ai-panel/')) return `AI 面板 > ${pageTitle}`
    if (pathname.includes('/tools/')) return `工具集 > ${pageTitle}`

    return pageTitle
  }, [pathname, pageTitle])

  useEffect(() => {
    document.title = `${pageTitle} | BelieveBoy Dashboard`
  }, [pageTitle])

  return (
    <SidebarProvider>
      <AppSidebar variant="inset" />
      <SidebarInset className="min-w-0 overflow-x-clip bg-transparent">
        <header className="sticky top-0 z-20 border-b border-border/45 bg-white/88 backdrop-blur-md">
          <div className="flex min-h-[4.5rem] items-center gap-4 px-3 md:px-5 lg:px-6 xl:px-8">
            <SidebarTrigger className="h-10 w-10 rounded-2xl bg-transparent text-secondary shadow-none hover:bg-[hsl(var(--surface-low))]" />
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
                className="h-10 w-full max-w-[24rem] justify-start rounded-2xl border-0 bg-[hsl(var(--surface-low))] px-4 text-muted-foreground shadow-none"
                onClick={() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))}
              >
                <Search className="h-4 w-4" />
                <span className="flex-1 text-left">搜索页面、工具与报表...</span>
                <span className="rounded-lg bg-white/90 px-2 py-1 text-[0.68rem] font-semibold text-foreground/70">⌘K</span>
              </Button>
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="outline"
                size="icon"
                className="h-10 w-10 rounded-2xl border-0 bg-[hsl(var(--surface-low))] shadow-none xl:hidden"
                onClick={() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))}
              >
                <Search className="h-4 w-4" />
                <span className="sr-only">Search</span>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-10 w-10 rounded-2xl bg-transparent text-secondary hover:bg-[hsl(var(--surface-low))]"
              >
                <Bell className="h-4 w-4" />
                <span className="sr-only">Notifications</span>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-10 w-10 rounded-2xl bg-transparent text-secondary hover:bg-[hsl(var(--surface-low))]"
              >
                <History className="h-4 w-4" />
                <span className="sr-only">History</span>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-10 w-10 rounded-2xl bg-transparent text-secondary hover:bg-[hsl(var(--surface-low))]"
              >
                <CircleHelp className="h-4 w-4" />
                <span className="sr-only">Help</span>
              </Button>
            </div>
          </div>
        </header>
        <main className="dashboard-full-width dashboard-page-shell relative min-w-0 flex-1 overflow-x-clip px-3 pb-6 pt-4 md:px-5 md:pb-8 lg:px-6 xl:px-8">
          <div className="min-h-[calc(100vh-8.5rem)]">
            {children}
          </div>
        </main>
      </SidebarInset>
      <SearchCommand />
    </SidebarProvider>
  )
}
