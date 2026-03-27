'use client'

import * as React from 'react'
import {
  BellRing,
  Bot,
  Calculator,
  ChartColumnBig,
  ChevronRight,
  Command,
  Database,
  FileUp,
  LayoutDashboard,
  PackageSearch,
  ShieldUser,
  Wrench,
} from 'lucide-react'
import { signOut, useSession } from 'next-auth/react'
import { usePathname } from 'next/navigation'

import { RouteLoadingLink } from '@/components/dashboard/route-loading-link'
import { NavUser } from '@/components/dashboard/nav-user'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
} from '@/components/ui/sidebar'

type NavLink = {
  title: string
  url: string
  matchPrefixes?: string[]
}

type NavGroup = {
  label: string
  icon: React.ReactNode
  accent: string
  activeAccent: string
  items: NavLink[]
}

const quickLinks: NavLink[] = [
  { title: '定价核算', url: '/dashboard/data-reporting/pricing-calculation' },
  { title: '数据分析', url: '/dashboard/data-analysis/daily-analysis' },
  {
    title: '补货分析',
    url: '/dashboard/data-analysis/inventory-replenishment',
  },
  { title: '报表上传', url: '/dashboard/data-management/report-upload' },
]

const quickLinkMeta: Record<
  string,
  {
    icon: React.ReactNode
    accent: string
    activeAccent: string
  }
> = {
  定价核算: {
    icon: <Calculator className='h-4.5 w-4.5' />,
    accent: 'bg-[linear-gradient(180deg,#5d4a12,#7d6618)] text-[#f7e39a]',
    activeAccent: 'bg-[linear-gradient(180deg,#7b6217,#a7841f)] text-[#fff1bf]',
  },
  数据分析: {
    icon: <ChartColumnBig className='h-4.5 w-4.5' />,
    accent: 'bg-[linear-gradient(180deg,#0d4d73,#1271a6)] text-[#9edcff]',
    activeAccent: 'bg-[linear-gradient(180deg,#10618f,#1788c6)] text-[#d2f0ff]',
  },
  补货分析: {
    icon: <PackageSearch className='h-4.5 w-4.5' />,
    accent: 'bg-[linear-gradient(180deg,#214b20,#387d35)] text-[#bff0a4]',
    activeAccent: 'bg-[linear-gradient(180deg,#2a6128,#449841)] text-[#ddffc8]',
  },
  报表上传: {
    icon: <FileUp className='h-4.5 w-4.5' />,
    accent: 'bg-[linear-gradient(180deg,#2440a8,#345de8)] text-[#d8e2ff]',
    activeAccent: 'bg-[linear-gradient(180deg,#2d4fc9,#3d6cff)] text-[#edf2ff]',
  },
}

const primaryGroups: NavGroup[] = [
  {
    label: '运营导航',
    icon: <LayoutDashboard className='h-4 w-4' />,
    accent: 'bg-[linear-gradient(180deg,#505050,#686868)] text-[#f5f5f5]',
    activeAccent: 'bg-[linear-gradient(180deg,#6a6a6a,#818181)] text-white',
    items: [
      { title: '站点导航', url: '/dashboard/operations/site-navigation' },
      { title: '店铺导航', url: '/dashboard/operations/store-navigation' },
    ],
  },
  {
    label: 'AI 面板',
    icon: <Bot className='h-4 w-4' />,
    accent: 'bg-[linear-gradient(180deg,#5a2f8f,#7b43c2)] text-[#efe0ff]',
    activeAccent: 'bg-[linear-gradient(180deg,#7340b4,#9558e0)] text-white',
    items: [{ title: 'AI 聊天', url: '/dashboard/ai-panel/chat' }],
  },
  {
    label: '运营核算',
    icon: <Calculator className='h-4 w-4' />,
    accent: 'bg-[linear-gradient(180deg,#6a5411,#92741a)] text-[#f9e6a6]',
    activeAccent: 'bg-[linear-gradient(180deg,#886b16,#b18c1e)] text-[#fff4c6]',
    items: [
      { title: '销售日报', url: '/dashboard/data-reporting/daily-report' },
      { title: '财务月报', url: '/dashboard/data-reporting/monthly-report' },
      { title: '产品分析', url: '/dashboard/data-reporting/product-analysis' },
      {
        title: '定价核算',
        url: '/dashboard/data-reporting/pricing-calculation',
      },
    ],
  },
  {
    label: '数据分析',
    icon: <ChartColumnBig className='h-4 w-4' />,
    accent: 'bg-[linear-gradient(180deg,#0f527a,#1675ae)] text-[#b3e3ff]',
    activeAccent: 'bg-[linear-gradient(180deg,#156896,#1b90cf)] text-[#def3ff]',
    items: [
      { title: '销售数据', url: '/dashboard/data-analysis/daily-analysis' },
      {
        title: '广告分析',
        url: '/dashboard/data-analysis/ad-analysis/overview',
        matchPrefixes: ['/dashboard/data-analysis/ad-analysis'],
      },
      { title: '月度财务分析', url: '/dashboard/data-analysis/financial-data' },
      {
        title: '按周产品分析',
        url: '/dashboard/data-analysis/weekly-product-analysis',
      },
      { title: '库存分析', url: '/dashboard/data-analysis/inventory-analysis' },
      {
        title: '补货分析',
        url: '/dashboard/data-analysis/inventory-replenishment',
      },
    ],
  },
  {
    label: '工具集',
    icon: <Wrench className='h-4 w-4' />,
    accent: 'bg-[linear-gradient(180deg,#0d6a53,#159271)] text-[#c7fff0]',
    activeAccent: 'bg-[linear-gradient(180deg,#118166,#1cab86)] text-white',
    items: [{ title: '调研分析', url: '/dashboard/tools/research-analysis' }],
  },
  {
    label: '数据管理',
    icon: <Database className='h-4 w-4' />,
    accent: 'bg-[linear-gradient(180deg,#8c3b5e,#bb5682)] text-[#ffe1ee]',
    activeAccent: 'bg-[linear-gradient(180deg,#aa4b72,#d46797)] text-white',
    items: [
      { title: '广告管理', url: '/dashboard/data-management/ad-upload' },
      { title: '报表上传', url: '/dashboard/data-management/report-upload' },
      {
        title: '发货管理',
        url: '/dashboard/data-management/shipment-management',
      },
      { title: 'SKU 信息', url: '/dashboard/data-management/sku-cost' },
      { title: '汇率信息', url: '/dashboard/data-management/exchange-rate' },
    ],
  },
]

const utilityLinks: Array<NavLink & { icon: React.ReactNode }> = [
  {
    title: '更新日志',
    url: '/dashboard/changelog',
    icon: <BellRing className='h-4 w-4' />,
  },
]

const adminGroup: NavGroup = {
  label: '系统管理',
  icon: <ShieldUser className='h-4 w-4' />,
  accent: 'bg-[linear-gradient(180deg,#4d4f8d,#676cc3)] text-[#e2e4ff]',
  activeAccent: 'bg-[linear-gradient(180deg,#6166ae,#7c82dd)] text-white',
  items: [
    { title: '项目信息', url: '/dashboard/system-management/project-info' },
    {
      title: '数据库状态',
      url: '/dashboard/system-management/data-management',
    },
    {
      title: '账号管理',
      url: '/dashboard/system-management/account-management',
    },
    {
      title: '运营管理',
      url: '/dashboard/system-management/operator-management',
    },
    {
      title: '项目佣金',
      url: '/dashboard/system-management/commission-overview',
    },
    { title: '日志查看', url: '/dashboard/system-management/logs' },
  ],
}

function isLinkActive(pathname: string, item: NavLink) {
  if (item.url === '/dashboard') return pathname === item.url
  if (pathname === item.url) return true
  return (
    item.matchPrefixes?.some((prefix) => pathname.startsWith(prefix)) ?? false
  )
}

function SidebarGroupBlock({ group }: { group: NavGroup }) {
  const pathname = usePathname()
  const hasActiveChild = group.items.some((item) =>
    isLinkActive(pathname, item),
  )

  return (
    <Collapsible
      asChild
      defaultOpen={hasActiveChild}
      className='group/collapsible'
    >
      <SidebarGroup className='px-2 py-0'>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton
            tooltip={group.label}
            isActive={hasActiveChild}
            className='rounded-[0.8rem] border-transparent bg-transparent px-3.5 py-2 text-sidebar-foreground/88 shadow-none hover:bg-[hsl(var(--sidebar-foreground)/0.03)] data-[active=true]:-translate-y-[1px] data-[active=true]:border-[hsl(var(--sidebar-foreground)/0.12)] data-[active=true]:bg-[linear-gradient(180deg,hsl(var(--sidebar-background)),hsl(var(--sidebar-background))_42%,hsl(var(--sidebar-foreground)/0.06)_100%)] data-[active=true]:text-sidebar-foreground data-[active=true]:ring-1 data-[active=true]:ring-[hsl(var(--sidebar-background)/0.95)] data-[active=true]:shadow-[0_18px_30px_-18px_hsl(var(--sidebar-foreground)/0.42),0_8px_16px_-12px_hsl(var(--sidebar-foreground)/0.22),0_1px_0_hsl(var(--sidebar-background)),inset_0_2px_0_hsl(var(--sidebar-background)),inset_0_-1px_0_hsl(var(--sidebar-foreground)/0.08)]'
          >
            <span
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[0.65rem] border border-[hsl(var(--sidebar-foreground)/0.08)] shadow-[inset_0_1px_0_hsl(var(--sidebar-foreground)/0.06)] ${
                hasActiveChild ? group.activeAccent : group.accent
              }`}
            >
              {group.icon}
            </span>
            <span className='flex min-w-0 flex-1 items-center gap-2'>
              <span className='min-w-0 truncate text-[0.95rem] font-semibold tracking-[-0.01em]'>
                {group.label}
              </span>
              <span className='rounded-full bg-[hsl(var(--sidebar-foreground)/0.05)] px-1.5 py-0.5 text-[0.6rem] font-semibold tabular-nums text-sidebar-foreground/42'>
                {group.items.length}
              </span>
            </span>
            <span className='flex h-7 w-7 items-center justify-center rounded-[0.65rem] text-sidebar-foreground/34 transition-colors duration-200 group-data-[state=open]/collapsible:bg-[hsl(var(--sidebar-foreground)/0.06)] group-data-[state=open]/collapsible:text-sidebar-foreground/72'>
              <ChevronRight className='transition-transform duration-300 ease-out group-data-[state=open]/collapsible:rotate-90' />
            </span>
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent className='overflow-hidden pt-2 data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down'>
          <SidebarMenuSub className='mx-0 mt-0 gap-1.5 pl-3 pr-1.5'>
            {group.items.map((item) => (
              <SidebarMenuSubItem key={item.title}>
                <SidebarMenuSubButton
                  asChild
                  isActive={isLinkActive(pathname, item)}
                  className='min-h-10 rounded-[0.8rem] px-3 text-[0.98rem] text-sidebar-foreground/70'
                >
                  <RouteLoadingLink href={item.url}>
                    <span>{item.title}</span>
                  </RouteLoadingLink>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarGroup>
    </Collapsible>
  )
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { data: session } = useSession()
  const pathname = usePathname()
  const user = session?.user

  const displayUser = {
    name: user?.name || 'User',
    email: user?.email || 'unknown',
    avatar: user?.image || '/avatars/default.svg',
    isAdmin: Boolean(user?.isAdmin),
  }

  return (
    <Sidebar collapsible='icon' {...props}>
      <SidebarHeader className='gap-3 px-4 pb-1 pt-4 group-data-[collapsible=icon]:px-2.5'>
        <div className='relative group-data-[collapsible=icon]:px-0'>
          <div className='relative flex items-start gap-3 group-data-[collapsible=icon]:justify-center'>
            <div className='flex h-11 w-11 shrink-0 items-center justify-center rounded-[0.7rem] bg-[linear-gradient(135deg,hsl(var(--primary)),hsl(var(--chart-2)))] text-sidebar-primary-foreground shadow-[0_14px_24px_-18px_hsl(var(--sidebar-primary)/0.75)]'>
              <Command className='size-4.5' />
            </div>
            <div className='min-w-0 flex-1 group-data-[collapsible=icon]:hidden'>
              <p className='text-[0.68rem] font-semibold tracking-[-0.02em] text-sidebar-foreground/96'>
                BelieveBoy
              </p>
              <div className='mt-1 flex items-center gap-2'>
                <h2 className='text-[1.02rem] font-semibold tracking-[-0.025em] text-sidebar-foreground/92'>
                  运营控制台
                </h2>
                <span className='rounded-full border border-[hsl(var(--sidebar-foreground)/0.1)] bg-[hsl(var(--sidebar-foreground)/0.04)] px-1.5 py-0.5 text-[0.58rem] font-semibold uppercase tracking-[0.16em] text-sidebar-foreground/48'>
                  Control
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className='overflow-visible border-t border-dashed border-[hsl(var(--sidebar-foreground)/0.08)] pt-3 group-data-[collapsible=icon]:hidden'>
          <div className='mb-2.5 flex items-center justify-between px-1'>
            <p className='text-[0.68rem] font-semibold uppercase tracking-[0.28em] text-sidebar-foreground/44'>
              Pinned
            </p>
          </div>
          <div className='grid grid-cols-4 gap-2 overflow-visible'>
            {quickLinks.map((link) => {
              const active = isLinkActive(pathname, link)
              const meta = quickLinkMeta[link.title]

              return (
                <RouteLoadingLink
                  key={link.title}
                  href={link.url}
                  aria-label={link.title}
                  className={`group relative flex min-h-[3.45rem] items-center justify-center overflow-visible rounded-[0.8rem] border px-2 py-2 transition-all duration-200 ${
                    active
                      ? 'border-[hsl(var(--sidebar-foreground)/0.12)] bg-[hsl(var(--sidebar-foreground)/0.08)] text-sidebar-accent-foreground shadow-[inset_0_1px_0_hsl(var(--sidebar-foreground)/0.05)]'
                      : 'border-transparent bg-transparent text-sidebar-foreground/78 hover:border-[hsl(var(--sidebar-foreground)/0.06)] hover:bg-[hsl(var(--sidebar-foreground)/0.035)]'
                  }`}
                >
                  <span
                    className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-[0.65rem] border border-[hsl(var(--sidebar-foreground)/0.08)] shadow-[inset_0_1px_0_hsl(var(--sidebar-foreground)/0.06)] ${
                      active
                        ? meta?.activeAccent
                        : meta?.accent
                    }`}
                  >
                    {meta?.icon}
                  </span>
                  <span className='pointer-events-none absolute left-1/2 top-full z-20 mt-2 -translate-x-1/2 rounded-[0.65rem] border border-[hsl(var(--sidebar-border))] bg-[hsl(var(--sidebar-background))] px-2.5 py-1.5 text-[0.72rem] font-semibold whitespace-nowrap text-sidebar-foreground opacity-0 shadow-[0_12px_24px_-16px_rgba(0,0,0,0.28)] transition-none group-hover:opacity-100 group-focus-visible:opacity-100'>
                    {link.title}
                  </span>
                  <span className='sr-only'>{link.title}</span>
                </RouteLoadingLink>
              )
            })}
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent className='gap-1.5 border-t border-[hsl(var(--sidebar-foreground)/0.08)] px-1 pt-2.5 pb-3'>
        <SidebarGroup className='px-2 pb-0.5 pt-0'>
          <SidebarGroupLabel className='flex items-center justify-between px-2 text-sidebar-foreground/36'>
            导航分类
          </SidebarGroupLabel>
        </SidebarGroup>

        {primaryGroups.map((group) => (
          <SidebarGroupBlock key={group.label} group={group} />
        ))}

        {displayUser.isAdmin ? <SidebarGroupBlock group={adminGroup} /> : null}

        <SidebarGroup className='mt-auto px-2 pt-2'>
          <SidebarGroupLabel className='px-2 text-sidebar-foreground/36'>
            支持入口
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className='gap-1.5'>
              {utilityLinks.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    asChild
                    tooltip={item.title}
                    isActive={isLinkActive(pathname, item)}
                    className='rounded-[0.8rem] border-transparent bg-transparent px-3.5 py-3 text-sidebar-foreground/78'
                  >
                    <RouteLoadingLink href={item.url}>
                      {item.icon}
                      <span>{item.title}</span>
                    </RouteLoadingLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className='px-3 pb-4 pt-2'>
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
