'use client'

import * as React from 'react'
import {
  Bot,
  Calculator,
  ChartColumnBig,
  ChevronDown,
  Database,
  LayoutDashboard,
  ShieldUser,
  Store,
  Users,
} from 'lucide-react'
import Link from 'next/link'
import { signOut, useSession } from 'next-auth/react'
import { usePathname } from 'next/navigation'

import { AIChatSidebar } from '@/components/dashboard/ai-chat-sidebar'
import { useDashboardAISidebar } from '@/components/dashboard/ai-sidebar-bridge'
import { RouteLoadingLink } from '@/components/dashboard/route-loading-link'
import { NavUser } from '@/components/dashboard/nav-user'
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
  SidebarSeparator,
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
  iconAccent?: string
  activeIconAccent?: string
  items: NavLink[]
}

const primaryGroups: NavGroup[] = [
  {
    label: '运营导航',
    icon: <LayoutDashboard className='h-6 w-6' />,
    accent: 'bg-[linear-gradient(180deg,#505050,#686868)] text-[#f5f5f5]',
    activeAccent: 'bg-[linear-gradient(180deg,#6a6a6a,#818181)] text-white',
    iconAccent: '#888888',
    activeIconAccent: 'rgba(255,255,255,0.95)',
    items: [
      { title: '站点导航', url: '/dashboard/operations/site-navigation' },
      { title: '店铺导航', url: '/dashboard/operations/store-navigation' },
    ],
  },
  {
    label: 'AI 面板',
    icon: <Bot className='h-6 w-6' />,
    accent: 'bg-[linear-gradient(180deg,#5a2f8f,#7b43c2)] text-[#efe0ff]',
    activeAccent: 'bg-[linear-gradient(180deg,#7340b4,#9558e0)] text-white',
    iconAccent: '#888888',
    activeIconAccent: 'rgba(255,255,255,0.95)',
    items: [
      { title: 'AI 聊天', url: '/dashboard/ai-panel/chat' },
      { title: 'AI 洞察', url: '/dashboard/ai-insights' },
    ],
  },
  {
    label: '运营核算',
    icon: <Calculator className='h-6 w-6' />,
    accent: 'bg-[linear-gradient(180deg,#6a5411,#92741a)] text-[#f9e6a6]',
    activeAccent: 'bg-[linear-gradient(180deg,#886b16,#b18c1e)] text-white',
    iconAccent: '#888888',
    activeIconAccent: 'rgba(255,255,255,0.95)',
    items: [
      { title: '财务月报', url: '/dashboard/data-reporting/monthly-report' },
      { title: '产品分析', url: '/dashboard/data-reporting/product-analysis' },
      {
        title: '新品核算',
        url: '/dashboard/data-reporting/pricing-calculation/new-product',
        matchPrefixes: [
          '/dashboard/data-reporting/pricing-calculation/new-product',
        ],
      },
      {
        title: '店铺测算',
        url: '/dashboard/data-reporting/pricing-calculation/shop-calculation',
        matchPrefixes: [
          '/dashboard/data-reporting/pricing-calculation/shop-calculation',
        ],
      },
    ],
  },
  {
    label: '数据分析',
    icon: <ChartColumnBig className='h-6 w-6' />,
    accent: 'bg-[linear-gradient(180deg,#0f527a,#1675ae)] text-[#b3e3ff]',
    activeAccent: 'bg-[linear-gradient(180deg,#156896,#1b90cf)] text-white',
    iconAccent: '#888888',
    activeIconAccent: 'rgba(255,255,255,0.95)',
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
      {
        title: '组合分析',
        url: '/dashboard/data-analysis/portfolio-overview',
      },
      { title: '退货分析', url: '/dashboard/data-analysis/return-analysis' },
      { title: '项目目标', url: '/dashboard/data-analysis/project-goals' },
      { title: '调研分析', url: '/dashboard/data-analysis/research-analysis' },
    ],
  },
  {
    label: '数据管理',
    icon: <Database className='h-6 w-6' />,
    accent: 'bg-[linear-gradient(180deg,#8c3b5e,#bb5682)] text-[#ffe1ee]',
    activeAccent: 'bg-[linear-gradient(180deg,#aa4b72,#d46797)] text-white',
    iconAccent: '#888888',
    activeIconAccent: 'rgba(255,255,255,0.95)',
    items: [
      { title: '广告管理', url: '/dashboard/data-management/ad-upload' },
      // { title: '报表上传', url: '/dashboard/data-management/report-upload' }, // 后端保留，前端临时隐藏
      {
        title: '发货管理',
        url: '/dashboard/data-management/shipment-management',
      },
      { title: 'SKU 信息', url: '/dashboard/data-management/sku-info' },
      {
        title: '报表核对',
        url: '/dashboard/data-management/report-reconciliation',
      },
      { title: '汇率信息', url: '/dashboard/data-management/exchange-rate' },
      { title: '报表自动化', url: '/dashboard/data-management/auto-upload' },
    ],
  },

]

const utilityLinks: Array<NavLink & { icon: React.ReactNode }> = [
  {
    title: '更新日志',
    url: '/dashboard/changelog',
    icon: <Database className='h-6 w-6' />,
  },
]

const businessDevGroup: NavGroup = {
  label: '招商管理',
  icon: <Store className='h-6 w-6' />,
  accent: 'bg-[linear-gradient(180deg,#1a3a5c,#2a5a8c)] text-[#b3d4ff]',
  activeAccent: 'bg-[linear-gradient(180deg,#1e4a72,#3478b0)] text-white',
  iconAccent: '#888888',
  activeIconAccent: 'rgba(255,255,255,0.95)',
  items: [
    { title: '招商面板（占位）', url: '/dashboard/business-dev/overview' },
    { title: '供应商管理（占位）', url: '/dashboard/business-dev/suppliers' },
    { title: '招商报表（占位）', url: '/dashboard/business-dev/reports' },
  ],
}

const digitalEmployeesGroup: NavGroup = {
  label: '数字员工',
  icon: <Users className='h-6 w-6' />,
  accent: 'bg-[linear-gradient(180deg,#1a5276,#2980b9)] text-[#d6eaf8]',
  activeAccent: 'bg-[linear-gradient(180deg,#1f6dad,#2980b9)] text-white',
  iconAccent: '#888888',
  activeIconAccent: 'rgba(255,255,255,0.95)',
  items: [{ title: '数字员工', url: '/dashboard/digital-employees' }],
}

const adminGroup: NavGroup = {
  label: '系统管理',
  icon: <ShieldUser className='h-6 w-6' />,
  accent: 'bg-[linear-gradient(180deg,#4d4f8d,#676cc3)] text-[#e2e4ff]',
  activeAccent: 'bg-[linear-gradient(180deg,#6166ae,#7c82dd)] text-white',
  iconAccent: '#888888',
  activeIconAccent: 'rgba(255,255,255,0.95)',
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
      url: '/dashboard/system-management/commission-management',
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
  const [isExpanded, setIsExpanded] = React.useState(false)
  const activeItem =
    group.items.find((item) => isLinkActive(pathname, item)) ?? group.items[0]
  const hasActiveItem = group.items.some((item) => isLinkActive(pathname, item))

  return (
    <SidebarGroup className='px-2 py-0'>
      <div
        className='mb-2 flex cursor-pointer items-center gap-2 px-2 group-data-[collapsible=icon]:mb-1 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0'
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div
          aria-label={group.label}
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[0.75rem] border border-[hsl(var(--sidebar-foreground)/0.08)] shadow-[inset_0_1px_0_hsl(var(--sidebar-foreground)/0.06)] transition-all duration-200 ${
            hasActiveItem ? group.activeAccent : group.accent
          }`}
        >
          <span
            style={{
              color: hasActiveItem ? 'inherit' : undefined,
              filter: hasActiveItem ? 'none' : 'grayscale(100%)',
            }}
          >
            {group.icon}
          </span>
        </div>
        <div className='min-w-0 flex-1 group-data-[collapsible=icon]:hidden'>
          <p className='truncate text-[0.82rem] font-semibold tracking-[-0.015em] text-sidebar-foreground/86'>
            {group.label}
          </p>
        </div>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-sidebar-foreground/50 transition-transform duration-300 ease-out ${
            isExpanded ? 'rotate-0' : '-rotate-90'
          }`}
        />
      </div>
      <div
        className={`overflow-hidden transition-all duration-300 ease-out group-data-[collapsible=icon]:hidden ${
          isExpanded ? 'max-h-[500px] opacity-100' : 'max-h-0 opacity-0'
        }`}
      >
        <SidebarMenu className='gap-0.5 pt-1'>
          {group.items.map((item) => (
            <SidebarMenuItem key={item.title}>
              <SidebarMenuButton
                asChild
                tooltip={item.title}
                isActive={isLinkActive(pathname, item)}
                className='h-11 rounded-[0.9rem] border border-transparent px-3 text-[0.96rem] font-medium text-sidebar-foreground/78 shadow-none hover:bg-[hsl(var(--sidebar-foreground)/0.03)] data-[active=true]:border-[hsl(var(--sidebar-foreground)/0.06)] data-[active=true]:bg-[hsl(var(--sidebar-foreground)/0.05)] data-[active=true]:text-sidebar-foreground'
              >
                <RouteLoadingLink href={item.url}>
                  <span className='min-w-0 flex-1 truncate whitespace-nowrap'>
                    {item.title}
                  </span>
                </RouteLoadingLink>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </div>
    </SidebarGroup>
  )
}

export function AppSidebar({
  aiChatMode = false,
  ...props
}: React.ComponentProps<typeof Sidebar> & { aiChatMode?: boolean }) {
  const { data: session } = useSession()
  const pathname = usePathname()
  const user = session?.user
  const isAiChatPage = aiChatMode || pathname === '/dashboard/ai-panel/chat'
  const { sidebarState } = useDashboardAISidebar()

  const displayUser = {
    name: user?.name || 'User',
    email: user?.email || 'unknown',
    avatar: user?.image || '/avatars/default.svg',
    roleType: user?.roleType,
  }

  return (
    <Sidebar collapsible='offcanvas' {...props}>
      {isAiChatPage && sidebarState ? (
        <div className='flex min-h-0 flex-1 flex-col animate-in slide-in-from-right-6 duration-300'>
          <AIChatSidebar {...sidebarState} />
        </div>
      ) : (
        <div className='flex min-h-0 flex-1 flex-col'>
          <SidebarHeader className='px-3 py-4'>
            <Link
              href='/dashboard'
              className='flex flex-col items-center justify-center gap-0.5 rounded-lg px-2 py-2 transition-colors hover:bg-[hsl(var(--sidebar-foreground)/0.04)]'
            >
              <span className='text-[1.7rem] font-bold tracking-tight text-sidebar-foreground'>
                BelieveBoy
              </span>
              <span className='text-[0.82rem] text-sidebar-foreground/56'>
                运营控制台
              </span>
            </Link>
          </SidebarHeader>

          <SidebarSeparator className='mx-4 bg-[hsl(var(--sidebar-foreground)/0.08)]' />

          <SidebarContent className='gap-3 px-3 py-3'>
            {primaryGroups.map((group) => (
              <SidebarGroupBlock key={group.label} group={group} />
            ))}

            {displayUser.roleType === 'admin' ? (
              <SidebarGroupBlock group={digitalEmployeesGroup} />
            ) : null}

            {displayUser.roleType === 'admin' ? (
              <SidebarGroupBlock group={adminGroup} />
            ) : null}

            {displayUser.roleType === 'businessdev' ||
            displayUser.roleType === 'admin' ? (
              <SidebarGroupBlock group={businessDevGroup} />
            ) : null}

            <SidebarGroup className='mt-auto px-2 py-0'>
              <SidebarGroupLabel className='mb-2 px-2 text-[0.74rem] font-semibold text-sidebar-foreground/42'>
                支持入口
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu className='gap-0.5'>
                  {utilityLinks.map((item) => (
                    <SidebarMenuItem key={item.title}>
                      <SidebarMenuButton
                        asChild
                        tooltip={item.title}
                        isActive={isLinkActive(pathname, item)}
                        className='h-10 rounded-[0.9rem] px-3 text-[0.92rem] text-sidebar-foreground/72 hover:bg-[hsl(var(--sidebar-foreground)/0.03)] data-[active=true]:bg-[hsl(var(--sidebar-foreground)/0.05)]'
                      >
                        <RouteLoadingLink href={item.url}>
                          {item.icon}
                          <span className='truncate whitespace-nowrap'>
                            {item.title}
                          </span>
                        </RouteLoadingLink>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>

          <SidebarSeparator className='mx-4 bg-[hsl(var(--sidebar-foreground)/0.08)]' />

          <SidebarFooter className='px-3 py-3'>
            <NavUser
              user={displayUser}
              onLogout={() => {
                void signOut({ callbackUrl: '/login' })
              }}
            />
          </SidebarFooter>
        </div>
      )}

      {!isAiChatPage ? <SidebarRail /> : null}
    </Sidebar>
  )
}
