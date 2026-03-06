'use client'

import { useMemo } from 'react'
import { usePathname } from 'next/navigation'
import { Separator } from '@/components/ui/separator'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { AppSidebar } from '@/components/dashboard/app-sidebar'
import { ThemeToggle } from '@/components/theme-toggle'
import { SearchCommand } from '@/components/dashboard/search-command'
import { Button } from '@/components/ui/button'
import { Search } from 'lucide-react'

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const pageTitle = useMemo(() => {
    if (pathname === '/dashboard') return '运营总览与关键数据面板'
    if (pathname.includes('/data-reporting/daily-report')) return '销售日报'
    if (pathname.includes('/data-reporting/monthly-report')) return '财务月报'
    if (pathname.includes('/data-reporting/product-analysis')) return '产品分析'
    if (pathname.includes('/data-analysis/financial-data')) return '财务数据'
    if (pathname.includes('/data-management/sku-cost')) return 'SKU 成本中心'
    if (pathname.includes('/data-management/project-info')) return '项目信息'
    if (pathname.includes('/data-analysis/business-report')) return '业务报告'
    if (pathname.includes('/data-analysis/ad-analysis')) return '广告分析'
    if (pathname.includes('/data-analysis/inventory-sales-analysis')) return '库存销售分析'
    if (pathname.includes('/change-password')) return '修改密码'
    if (pathname.includes('/system-management/data-management')) return '数据库状态'
    if (pathname.includes('/system-management/account-management')) return '系统账号管理'
    if (pathname.includes('/system-management/commission-overview')) return '佣金管理'
    if (pathname.includes('/system-management/commission-management')) return '佣金管理'
    if (pathname.includes('/system-management/logs')) return '日志查看'
    if (pathname.includes('/operations/site-navigation')) return '跨境平台书签导航'
    if (pathname.includes('/ai-panel/chat')) return 'AI 聊天面板'
    if (pathname.includes('/tools/research-analysis')) return '调研分析'
    if (pathname.includes('/changelog')) return '更新日志'
    return 'Dashboard'
  }, [pathname])

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="min-w-0 overflow-x-hidden">
        <header className="sticky top-0 z-20 border-b border-border/80 bg-background/90 backdrop-blur supports-[backdrop-filter]:bg-background/70">
          <div className="flex h-[4.5rem] items-center gap-2 px-4 md:h-20 md:px-6">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-2 h-5" />
            <h1 className="line-clamp-1 flex-1 text-lg font-semibold tracking-tight md:text-2xl">{pageTitle}</h1>
            <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 rounded-lg"
              onClick={() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))}
            >
              <Search className="h-4 w-4" />
              <span className="sr-only">Search</span>
            </Button>
            <ThemeToggle />
            </div>
          </div>
        </header>
        <main className="dashboard-full-width relative min-w-0 flex-1 overflow-x-hidden p-4 md:p-6 lg:p-8">
          {children}
        </main>
      </SidebarInset>
      <SearchCommand />
    </SidebarProvider>
  )
}
