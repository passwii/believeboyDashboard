'use client'

import * as React from 'react'
import {
  Bot,
  ChartColumnBig,
  Command,
  ClipboardList,
  FolderKanban,
  Wrench,
  LayoutDashboard,
  SquareTerminal,
  HelpCircle,
  Search,
} from 'lucide-react'

import { NavMain } from '@/components/dashboard/nav-main'
import { NavTools } from '@/components/dashboard/nav-tools'
import { NavSecondary } from '@/components/dashboard/nav-secondary'
import { NavUser } from '@/components/dashboard/nav-user'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
} from '@/components/ui/sidebar'

// This is sample data.
const data = {
  user: {
    name: 'shadcn',
    email: 'm@example.com',
    avatar: '/avatars/shadcn.jpg',
  },
  navMain: [
    {
      title: '运营导航',
      url: '#',
      icon: <LayoutDashboard className="h-4 w-4" />,
      isActive: true,
      items: [
        {
          title: '运营总览',
          url: '#',
        },
        {
          title: '站点导航',
          url: '#',
        },
        {
          title: '店铺导航',
          url: '#',
        },
      ],
    },
    {
      title: 'AI 面板',
      url: '#',
      icon: <Bot className="h-4 w-4" />,
      items: [
        {
          title: 'AI 菜单 1',
          url: '#',
        },
        {
          title: 'AI 菜单 2',
          url: '#',
        },
        {
          title: 'AI 菜单 3',
          url: '#',
        },
      ],
    },
    {
      title: '运营文件',
      url: '#',
      icon: <FolderKanban className="h-4 w-4" />,
      items: [
        {
          title: 'SKU 成本表',
          url: '#',
        },
        {
          title: '项目进度表',
          url: '#',
        },
        {
          title: '利润测算表',
          url: '#',
        },
      ],
    },
    {
      title: '工作协作',
      url: '#',
      icon: <ClipboardList className="h-4 w-4" />,
      items: [
        {
          title: '工作日历',
          url: '#',
        },
        {
          title: '运营工作台',
          url: '#',
        },
        {
          title: '运营公告',
          url: '#',
        },
      ],
    },
  ],
  navSecondary: [
    {
      title: '运营总览',
      url: '#',
      icon: <SquareTerminal className="h-4 w-4" />,
    },
    {
      title: '帮助中心',
      url: '#',
      icon: <HelpCircle className="h-4 w-4" />,
    },
    {
      title: '全局搜索',
      url: '#',
      icon: <Search className="h-4 w-4" />,
    },
  ],
  tools: [
    {
      title: '数据分析',
      icon: <ChartColumnBig className="h-4 w-4" />,
      items: [
        {
          title: '销售日报',
          url: '#',
        },
        {
          title: '财务月报',
          url: '#',
        },
        {
          title: '产品分析表',
          url: '#',
        },
      ],
    },
    {
      title: '工具集',
      icon: <Wrench className="h-4 w-4" />,
      items: [
        {
          title: 'API站点',
          url: '#',
        },
        {
          title: 'BLF图床',
          url: '#',
        },
        {
          title: '调研分析',
          url: '#',
        },
        {
          title: '亚马逊采集',
          url: '#',
        },
      ],
    },
  ],
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <div className="flex items-center gap-2 overflow-hidden px-4 py-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:px-2">
          <div className="flex aspect-square size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
            <Command className="size-4" />
          </div>
          <div className="flex min-w-0 flex-col gap-0.5 leading-none transition-opacity duration-200 group-data-[collapsible=icon]:w-0 group-data-[collapsible=icon]:opacity-0">
            <span className="font-semibold">BelieveBoy</span>
            <span className="text-xs text-muted-foreground">Dashboard v1.0</span>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={data.navMain} />
        <NavTools tools={data.tools} />
        <NavSecondary items={data.navSecondary} />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={data.user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
