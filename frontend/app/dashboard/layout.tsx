'use client'

import { useEffect, useMemo } from 'react'
import { usePathname } from 'next/navigation'
import { Separator } from '@/components/ui/separator'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { AppSidebar } from '@/components/dashboard/app-sidebar'
import { ThemeToggle } from '@/components/theme-toggle'
import { SearchCommand } from '@/components/dashboard/search-command'
import { Button } from '@/components/ui/button'
import { Search } from 'lucide-react'

const DASHBOARD_PAGE_TITLES: Array<{ match: string; title: string }> = [
  { match: '/data-reporting/daily-report', title: '销售日报' },
  { match: '/data-reporting/monthly-report', title: '财务月报' },
  { match: '/data-reporting/product-analysis', title: '产品分析' },
  { match: '/data-reporting/pricing-calculation', title: '定价核算' },
  { match: '/data-analysis/financial-data', title: '月度财务分析' },
  { match: '/data-analysis/daily-analysis', title: '日报分析' },
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

  useEffect(() => {
    document.title = `${pageTitle} | BelieveBoy Dashboard`
  }, [pageTitle])

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="min-w-0 overflow-x-clip">
        <header className="sticky top-0 z-20 border-b border-border/80 bg-background/90 backdrop-blur supports-[backdrop-filter]:bg-background/70">
          <div className="flex h-[4.25rem] items-center gap-2 px-4 md:h-[4.5rem] md:px-5 xl:h-20 xl:px-6">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-2 h-5" />
            <h1 className="line-clamp-1 flex-1 text-base font-semibold tracking-tight md:text-xl xl:text-2xl">{pageTitle}</h1>
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
        <main className="dashboard-full-width relative min-w-0 flex-1 overflow-x-clip p-4 md:p-5 lg:p-6 xl:p-8">
          {children}
        </main>
      </SidebarInset>
      <SearchCommand />
    </SidebarProvider>
  )
}
