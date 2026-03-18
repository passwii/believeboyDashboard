'use client'

import * as React from 'react'
import { Bot, Calculator, ChartColumnBig, ClipboardList, Command, Database, FolderKanban, HelpCircle, LayoutDashboard, ShieldUser, Wrench } from 'lucide-react'
import { signOut, useSession } from 'next-auth/react'

import { NavAdmin } from '@/components/dashboard/nav-admin'
import { NavMain } from '@/components/dashboard/nav-main'
import { NavSecondary } from '@/components/dashboard/nav-secondary'
import { NavTools } from '@/components/dashboard/nav-tools'
import { NavUser } from '@/components/dashboard/nav-user'
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarRail } from '@/components/ui/sidebar'

const navMain = [
  {
    title: '工作台',
    url: '#',
    icon: <ClipboardList className="h-4 w-4" />,
    items: [
      { title: '工作日历', url: '#' },
      { title: '运营工作台', url: '#' },
      { title: '运营公告', url: '#' },
    ],
  },
  {
    title: '运营导航',
    url: '#',
    icon: <LayoutDashboard className="h-4 w-4" />,
    isActive: true,
    items: [
      { title: '站点导航', url: '/dashboard/operations/site-navigation' },
      { title: '店铺导航', url: '/dashboard/operations/store-navigation' },
    ],
  },
  {
    title: 'AI 面板',
    url: '#',
    icon: <Bot className="h-4 w-4" />,
    items: [
      { title: 'AI 聊天', url: '/dashboard/ai-panel/chat' },
    ],
  },
  {
    title: '运营文件',
    url: '#',
    icon: <FolderKanban className="h-4 w-4" />,
    items: [
      { title: 'SKU 信息表', url: '#' },
      { title: '项目进度表', url: '#' },
      { title: '利润测算表', url: '#' },
    ],
  },
]

const navSecondary = [
  { title: '更新日志', url: '/dashboard/changelog', icon: <HelpCircle className="h-4 w-4" /> },
]

const tools = [
  {
    title: '运营核算',
    icon: <Calculator className="h-4 w-4" />,
    items: [
      { title: '销售日报', url: '/dashboard/data-reporting/daily-report' },
      { title: '财务月报', url: '/dashboard/data-reporting/monthly-report' },
      { title: '产品分析', url: '/dashboard/data-reporting/product-analysis' },
      { title: '定价核算', url: '/dashboard/data-reporting/pricing-calculation' },
    ],
  },
  {
    title: '数据分析',
    icon: <ChartColumnBig className="h-4 w-4" />,
    items: [
      { title: '月度财务分析', url: '/dashboard/data-analysis/financial-data' },
      { title: '按周产品分析', url: '/dashboard/data-analysis/weekly-product-analysis' },
      { title: '库存及补货分析', url: '/dashboard/data-analysis/inventory-replenishment' },
    ],
  },
  {
    title: '工具集',
    icon: <Wrench className="h-4 w-4" />,
    items: [
      { title: '调研分析', url: '/dashboard/tools/research-analysis' },
      { title: 'API站点', url: '#' },
      { title: 'BLF图床', url: '#' },
      { title: '亚马逊采集', url: '#' },
    ],
  },
  {
    title: '数据管理',
    icon: <Database className="h-4 w-4" />,
    items: [
      { title: '报表上传', url: '/dashboard/data-management/report-upload' },
      { title: '发货管理', url: '/dashboard/data-management/shipment-management' },
      { title: 'SKU信息', url: '/dashboard/data-management/sku-cost' },
      { title: '汇率信息', url: '/dashboard/data-management/exchange-rate' },
    ],
  },
]

const adminTools = [
  {
    title: '系统管理',
    icon: <ShieldUser className="h-4 w-4" />,
    items: [
      { title: '项目信息', url: '/dashboard/system-management/project-info' },
      { title: '数据库状态', url: '/dashboard/system-management/data-management' },
      { title: '账号管理', url: '/dashboard/system-management/account-management' },
      { title: '佣金管理', url: '/dashboard/system-management/commission-overview' },
      { title: '日志查看', url: '/dashboard/system-management/logs' },
    ],
  },
]

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { data: session } = useSession()
  const user = session?.user

  const displayUser = {
    name: user?.name || 'User',
    email: user?.email || 'unknown',
    avatar: user?.image || '/avatars/default.svg',
    isAdmin: Boolean(user?.isAdmin),
  }

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <div className="flex items-center gap-2 overflow-hidden px-4 py-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:px-2">
          <div className="flex aspect-square size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
            <Command className="size-4" />
          </div>
          <div className="flex min-w-0 flex-col gap-0.5 leading-none transition-opacity duration-200 group-data-[collapsible=icon]:w-0 group-data-[collapsible=icon]:opacity-0">
            <span className="text-base font-semibold tracking-tight">BelieveBoy</span>
            <span className="text-xs font-medium text-muted-foreground/90">Dashboard v1.0</span>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={navMain} />
        <NavTools tools={tools} />
        {displayUser.isAdmin ? <NavAdmin adminTools={adminTools} /> : null}
        <NavSecondary items={navSecondary} />
      </SidebarContent>
      <SidebarFooter>
        <NavUser
          user={displayUser}
          onLogout={() => {
            void signOut({ callbackUrl: '/login' })
          }}
        />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
