'use client'

import * as React from 'react'
import {
  BellRing,
  Bot,
  Calculator,
  ChartColumnBig,
  ChevronRight,
  ClipboardList,
  Command,
  Database,
  FolderKanban,
  LayoutDashboard,
  ShieldUser,
  Sparkles,
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
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  useSidebar,
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
  items: NavLink[]
}

const quickLinks: NavLink[] = [
  { title: '运营总览', url: '/dashboard' },
  { title: 'AI 聊天', url: '/dashboard/ai-panel/chat' },
  { title: '站点导航', url: '/dashboard/operations/site-navigation' },
  { title: '上传中心', url: '/dashboard/data-management/report-upload' },
]

const primaryGroups: NavGroup[] = [
  {
    label: '运营导航',
    icon: <LayoutDashboard className="h-4 w-4" />,
    accent: 'from-sky-500/18 via-sky-500/8 to-transparent',
    items: [
      { title: '站点导航', url: '/dashboard/operations/site-navigation' },
      { title: '店铺导航', url: '/dashboard/operations/store-navigation' },
    ],
  },
  {
    label: 'AI 面板',
    icon: <Bot className="h-4 w-4" />,
    accent: 'from-violet-500/18 via-violet-500/8 to-transparent',
    items: [
      { title: 'AI 聊天', url: '/dashboard/ai-panel/chat' },
    ],
  },
  {
    label: '运营核算',
    icon: <Calculator className="h-4 w-4" />,
    accent: 'from-amber-500/16 via-amber-500/8 to-transparent',
    items: [
      { title: '销售日报', url: '/dashboard/data-reporting/daily-report' },
      { title: '财务月报', url: '/dashboard/data-reporting/monthly-report' },
      { title: '产品分析', url: '/dashboard/data-reporting/product-analysis' },
      { title: '定价核算', url: '/dashboard/data-reporting/pricing-calculation' },
    ],
  },
  {
    label: '数据分析',
    icon: <ChartColumnBig className="h-4 w-4" />,
    accent: 'from-emerald-500/18 via-emerald-500/8 to-transparent',
    items: [
      { title: '销售数据', url: '/dashboard/data-analysis/daily-analysis' },
      {
        title: '广告分析',
        url: '/dashboard/data-analysis/ad-analysis/overview',
        matchPrefixes: ['/dashboard/data-analysis/ad-analysis'],
      },
      { title: '月度财务分析', url: '/dashboard/data-analysis/financial-data' },
      { title: '按周产品分析', url: '/dashboard/data-analysis/weekly-product-analysis' },
      { title: '库存分析', url: '/dashboard/data-analysis/inventory-analysis' },
      { title: '补货分析', url: '/dashboard/data-analysis/inventory-replenishment' },
    ],
  },
  {
    label: '工具集',
    icon: <Wrench className="h-4 w-4" />,
    accent: 'from-cyan-500/18 via-cyan-500/8 to-transparent',
    items: [
      { title: '调研分析', url: '/dashboard/tools/research-analysis' },
    ],
  },
  {
    label: '数据管理',
    icon: <Database className="h-4 w-4" />,
    accent: 'from-rose-500/16 via-rose-500/8 to-transparent',
    items: [
      { title: '报表上传', url: '/dashboard/data-management/report-upload' },
      { title: '发货管理', url: '/dashboard/data-management/shipment-management' },
      { title: 'SKU 信息', url: '/dashboard/data-management/sku-cost' },
      { title: '汇率信息', url: '/dashboard/data-management/exchange-rate' },
    ],
  },
]

const utilityLinks: Array<NavLink & { icon: React.ReactNode }> = [
  { title: '更新日志', url: '/dashboard/changelog', icon: <BellRing className="h-4 w-4" /> },
]

const adminGroup: NavGroup = {
  label: '系统管理',
  icon: <ShieldUser className="h-4 w-4" />,
  accent: 'from-fuchsia-500/18 via-fuchsia-500/8 to-transparent',
  items: [
    { title: '项目信息', url: '/dashboard/system-management/project-info' },
    { title: '数据库状态', url: '/dashboard/system-management/data-management' },
    { title: '账号管理', url: '/dashboard/system-management/account-management' },
    { title: '佣金管理', url: '/dashboard/system-management/commission-overview' },
    { title: '日志查看', url: '/dashboard/system-management/logs' },
  ],
}

function isLinkActive(pathname: string, item: NavLink) {
  if (item.url === '/dashboard') return pathname === item.url
  if (pathname === item.url) return true
  return item.matchPrefixes?.some((prefix) => pathname.startsWith(prefix)) ?? false
}

function SidebarGroupBlock({ group }: { group: NavGroup }) {
  const pathname = usePathname()
  const hasActiveChild = group.items.some((item) => isLinkActive(pathname, item))

  return (
    <Collapsible asChild defaultOpen={hasActiveChild} className="group/collapsible">
      <SidebarGroup className="px-2 py-1.5">
        <CollapsibleTrigger asChild>
          <SidebarMenuButton
            tooltip={group.label}
            isActive={hasActiveChild}
            className="min-h-12 rounded-[1rem] border-sidebar-border/70 bg-sidebar-accent/55 px-3.5"
          >
            <span
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${group.accent} text-sidebar-foreground shadow-[inset_0_1px_0_hsl(0_0%_100%/0.25)]`}
            >
              {group.icon}
            </span>
            <span className="font-semibold">{group.label}</span>
            <ChevronRight className="ml-auto transition-transform duration-300 ease-out group-data-[state=open]/collapsible:rotate-90" />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent className="overflow-hidden pt-2 data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
          <SidebarMenuSub className="mx-0 mt-0 gap-1.5 border-l border-sidebar-border/55 pl-3.5">
            {group.items.map((item) => (
              <SidebarMenuSubItem key={item.title}>
                <SidebarMenuSubButton asChild isActive={isLinkActive(pathname, item)} className="min-h-10 rounded-xl px-3.5 text-[0.92rem]">
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
  const { state } = useSidebar()
  const user = session?.user

  const displayUser = {
    name: user?.name || 'User',
    email: user?.email || 'unknown',
    avatar: user?.image || '/avatars/default.svg',
    isAdmin: Boolean(user?.isAdmin),
  }

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader className="gap-3 px-3 pb-2 pt-3">
        <div className="relative overflow-hidden rounded-[1.5rem] border border-sidebar-border/70 bg-[linear-gradient(160deg,hsl(var(--sidebar-accent)/0.96),hsl(var(--sidebar-background))_74%)] px-4 py-4 shadow-[var(--shadow-soft)] group-data-[collapsible=icon]:rounded-[1.2rem] group-data-[collapsible=icon]:px-2.5 group-data-[collapsible=icon]:py-2.5">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-20 bg-[radial-gradient(circle_at_top_left,hsl(var(--sidebar-primary)/0.22),transparent_70%)]" />
          <div className="relative flex items-start gap-3 group-data-[collapsible=icon]:justify-center">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[linear-gradient(135deg,hsl(var(--primary)),hsl(var(--chart-2)))] text-sidebar-primary-foreground shadow-[0_18px_36px_-18px_hsl(var(--sidebar-primary)/0.9)]">
              <Command className="size-5" />
            </div>
            <div className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
              <div className="flex items-center gap-2">
                <p className="text-[0.7rem] font-semibold uppercase tracking-[0.28em] text-sidebar-foreground/52">
                  BelieveBoy
                </p>
                <span className="rounded-full border border-sidebar-border/70 bg-sidebar-accent/75 px-2 py-0.5 text-[0.62rem] font-semibold text-sidebar-foreground/72">
                  Control
                </span>
              </div>
              <h2 className="mt-2 text-[1.15rem] font-semibold tracking-tight text-sidebar-foreground">
                运营控制台
              </h2>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 group-data-[collapsible=icon]:hidden">
          {quickLinks.map((link, index) => {
            const active = isLinkActive(pathname, link)
            const icons = [<ClipboardList key="a" className="h-4 w-4" />, <Bot key="b" className="h-4 w-4" />, <FolderKanban key="c" className="h-4 w-4" />, <Database key="d" className="h-4 w-4" />]

            return (
              <RouteLoadingLink
                key={link.title}
                href={link.url}
                className={`flex min-h-16 items-center gap-3 rounded-[1.1rem] border px-3 py-3 transition-all duration-200 ${
                  active
                    ? 'border-primary/25 bg-primary/12 text-sidebar-accent-foreground shadow-[0_16px_30px_-22px_hsl(var(--primary)/0.75)]'
                    : 'border-sidebar-border/65 bg-sidebar-accent/58 text-sidebar-foreground/78 hover:border-sidebar-border hover:bg-sidebar-accent'
                }`}
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-sidebar-background/85 text-sidebar-foreground shadow-[inset_0_1px_0_hsl(0_0%_100%/0.15)]">
                  {icons[index]}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{link.title}</div>
                </div>
              </RouteLoadingLink>
            )
          })}
        </div>
      </SidebarHeader>

      <SidebarContent className="gap-2 px-1 pb-3">
        <SidebarGroup className="px-2 pb-1 pt-0">
          <SidebarGroupLabel className="flex items-center justify-between px-2 text-sidebar-foreground/48">
            导航分类
            <span className="rounded-full border border-sidebar-border/65 px-2 py-0.5 text-[0.6rem] tracking-[0.18em] text-sidebar-foreground/42">
              {primaryGroups.length} GROUPS
            </span>
          </SidebarGroupLabel>
        </SidebarGroup>

        {primaryGroups.map((group) => (
          <SidebarGroupBlock key={group.label} group={group} />
        ))}

        {displayUser.isAdmin ? <SidebarGroupBlock group={adminGroup} /> : null}

        <SidebarGroup className="mt-auto px-2 pt-3">
          <SidebarGroupLabel className="px-2 text-sidebar-foreground/48">支持入口</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-1.5">
              {utilityLinks.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    asChild
                    tooltip={item.title}
                    isActive={isLinkActive(pathname, item)}
                    className="min-h-11 rounded-[1rem] bg-sidebar-accent/45 px-3.5"
                  >
                    <RouteLoadingLink href={item.url}>
                      {item.icon}
                      <span>{item.title}</span>
                    </RouteLoadingLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
              <SidebarMenuItem>
                <SidebarMenuButton tooltip="当前布局模式" className="min-h-11 rounded-[1rem] bg-[linear-gradient(135deg,hsl(var(--sidebar-accent)/0.9),hsl(var(--sidebar-background)))] px-3.5">
                  <Sparkles className="h-4 w-4" />
                  <span>新版侧边栏</span>
                  <SidebarMenuBadge className="right-3 rounded-full bg-primary/12 px-2 text-[0.65rem] text-primary">
                    {state === 'collapsed' ? 'mini' : 'live'}
                  </SidebarMenuBadge>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="px-3 pb-4 pt-2">
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
