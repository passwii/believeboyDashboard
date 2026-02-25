'use client'

import { useMemo } from 'react'
import { usePathname } from 'next/navigation'
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage } from '@/components/ui/breadcrumb'
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
    if (pathname.includes('/data-analysis/daily-report')) return '销售日报'
    if (pathname.includes('/data-analysis/monthly-report')) return '财务月报'
    if (pathname.includes('/data-analysis/product-analysis')) return '产品分析'
    if (pathname.includes('/data-management/sku-cost')) return 'SKU成本'
    if (pathname.includes('/data-management/store-info')) return '店铺信息'
    return 'Dashboard'
  }, [pathname])

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="sticky top-0 z-20 flex h-16 shrink-0 items-center gap-2 border-b border-border/80 bg-background/90 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/70">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 h-4" />
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage className="text-base font-semibold tracking-tight md:text-[17px]">{pageTitle}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <div className="flex flex-1 items-center justify-end gap-2">
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
        </header>
        <main className="flex-1 p-4 md:p-6 lg:p-8">
          {children}
        </main>
      </SidebarInset>
      <SearchCommand />
    </SidebarProvider>
  )
}
