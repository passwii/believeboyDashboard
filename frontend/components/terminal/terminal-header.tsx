'use client'

import * as React from 'react'
import { useSession } from 'next-auth/react'
import { Bell, LogOut, Menu, PanelLeft, PanelRight, Search, UserRound } from 'lucide-react'

import { RouteLoadingLink } from '@/components/dashboard/route-loading-link'
import { OPEN_SEARCH_EVENT } from '@/components/dashboard/search-command'
import {
  TERMINAL_HEADER_HEIGHT,
} from '@/components/terminal/terminal-constants'
import {
  HeaderCountrySelect,
  HeaderDateRangePicker,
  HeaderKpiTile,
  HeaderProjectSelect,
} from '@/components/terminal/header-filter-suite'
import {
  isGlobalFilterPilotRoute,
  useTerminalGlobalFilter,
} from '@/components/terminal/global-filter-context'
import { useHeaderKpis } from '@/lib/hooks/use-header-kpis'
import type { SidebarTopGroup } from '@/lib/sidebar-config'
import { useServerNotifications } from '@/components/notifications/server-notifications-context'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { NotificationListView } from '@/components/notifications/notification-list-view'
import { getDashboardPageTitle } from '@/lib/dashboard-route-meta'
import { cn } from '@/lib/utils'

interface TerminalHeaderProps {
  groups: SidebarTopGroup[]
  activeGroupId?: string
  pathname: string
  subnavCollapsed: boolean
  onExpandSubnav: () => void
  inspectorOpen: boolean
  onToggleInspector: () => void
  /** <md 时打开移动端导航抽屉 */
  onOpenMobileNav?: () => void
}

/**
 * Top Header 全局控制台条（固定 48px，BLF-809；二档放大 2026-08-25）。
 * 左：SubNav 展开/折叠 + 面包屑（域 › 模块）。
 * 中：全局筛选四件套 + KPI 磁贴（BLF-819，仅试点路由激活；未接入页面零变化）。
 * 右：⌘K 搜索、通知、Inspector 开关、用户菜单。
 */
export function TerminalHeader({
  groups,
  activeGroupId,
  pathname,
  subnavCollapsed,
  onExpandSubnav,
  inspectorOpen,
  onToggleInspector,
  onOpenMobileNav,
}: TerminalHeaderProps) {
  const { data: session } = useSession()
  const user = session?.user
  const { unreadCount, refresh } = useServerNotifications()

  // BLF-819 全局筛选四件套：仅试点路由渲染，其余页面头部行为零变化
  const globalFilter = useTerminalGlobalFilter()
  const pilotActive = isGlobalFilterPilotRoute(pathname)
  const { kpis, loading: kpisLoading } = useHeaderKpis()
  const formatMoney0 = React.useCallback(
    (v: number | null) => (v == null ? null : `$${Math.round(v).toLocaleString('en-US')}`),
    []
  )

  const activeGroup = groups.find((g) => g.id === activeGroupId)
  const pageTitle = React.useMemo(() => getDashboardPageTitle(pathname), [pathname])
  const displayName = user?.name || 'User'

  return (
    <header
      style={{ height: TERMINAL_HEADER_HEIGHT }}
      className="flex shrink-0 items-stretch border-b border-term-border bg-term-panel"
    >
      {/* 左段：subnav 切换 + 面包屑 */}
      <div className="flex min-w-0 flex-1 items-center gap-1 px-2">
        <button
          type="button"
          onClick={onOpenMobileNav}
          title="导航菜单"
          aria-label="打开导航菜单"
          className="flex h-8 w-8 shrink-0 items-center justify-center text-term-muted transition-colors hover:bg-term-hover hover:text-term-text md:hidden"
        >
          <Menu className="h-[18px] w-[18px]" />
        </button>
        <button
          type="button"
          onClick={onExpandSubnav}
          title={subnavCollapsed ? '展开侧栏' : '侧栏'}
          aria-label={subnavCollapsed ? '展开侧栏' : '侧栏'}
          className="hidden h-8 w-8 shrink-0 items-center justify-center text-term-muted transition-colors hover:bg-term-hover hover:text-term-text md:flex"
        >
          <PanelLeft className={cn('h-[18px] w-[18px]', !subnavCollapsed && 'text-term-text')} />
        </button>
        <nav aria-label="面包屑" className="flex min-w-0 items-center gap-1.5 text-sm">
          {activeGroup && (
            <>
              <span
                className="shrink-0 uppercase tracking-wide text-term-faint transition-colors hover:text-term-muted"
                title={activeGroup.label}
              >
                {activeGroup.label}
              </span>
              <span
                aria-hidden
                className="shrink-0 select-none font-mono text-xs leading-none text-term-border"
              >
                ›
              </span>
            </>
          )}
          <span className="min-w-0 truncate font-medium tracking-tight text-term-text">
            {pageTitle}
          </span>
        </nav>
      </div>

      {/* 中段：全局筛选四件套 + KPI 磁贴（BLF-819，试点路由激活） */}
      {pilotActive && globalFilter.ready ? (
        <div className="hidden shrink-0 items-center gap-1.5 overflow-x-auto border-l border-term-border px-2 term-scroll xl:flex">
          <HeaderProjectSelect
            value={globalFilter.projectId}
            onChange={globalFilter.setProjectId}
          />
          <HeaderCountrySelect
            value={globalFilter.country}
            onChange={globalFilter.setCountry}
          />
          <HeaderDateRangePicker
            dateFrom={globalFilter.dateFrom}
            dateTo={globalFilter.dateTo}
            country={globalFilter.country}
            onChange={globalFilter.setDateRange}
          />
          <span className="mx-0.5 hidden h-4 w-px bg-term-border 2xl:block" aria-hidden />
          <div className="hidden items-center gap-1.5 2xl:flex">
            <HeaderKpiTile label="GMV" value={formatMoney0(kpis.gmv)} loading={kpisLoading} />
            <HeaderKpiTile
              label="ORD"
              value={kpis.orders == null ? null : kpis.orders.toLocaleString('en-US')}
              loading={kpisLoading}
            />
            <HeaderKpiTile
              label="PND"
              value={kpis.pending == null ? null : kpis.pending.toLocaleString('en-US')}
              loading={kpisLoading}
            />
          </div>
        </div>
      ) : null}

      {/* 右段：搜索 / 通知 / Inspector / 用户 */}
      <div className="flex shrink-0 items-center gap-1 px-2">
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent(OPEN_SEARCH_EVENT))}
          title="全局搜索"
          aria-label="全局搜索"
          className="flex h-8 items-center gap-1 px-1.5 text-term-muted transition-colors hover:bg-term-hover hover:text-term-text"
        >
          <Search className="h-[18px] w-[18px]" />
        </button>

        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              onClick={() => void refresh()}
              title="通知"
              aria-label={`通知${unreadCount > 0 ? `，${unreadCount} 条未读` : ''}`}
              className="relative flex h-8 w-8 items-center justify-center text-term-muted transition-colors hover:bg-term-hover hover:text-term-text"
            >
              <Bell className="h-[18px] w-[18px]" />
              {unreadCount > 0 && (
                <span
                  data-testid="terminal-header-unread"
                  className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center bg-term-neg px-0.5 font-mono text-[11px] leading-none text-white"
                >
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent
            side="bottom"
            align="end"
            className="w-[340px] rounded-none border-term-border bg-term-panel p-0"
          >
            <div className="max-h-[60vh] overflow-y-auto term-scroll">
              <NotificationListView onBack={() => {}} onNavigateClose={() => {}} />
            </div>
          </PopoverContent>
        </Popover>

        <button
          type="button"
          onClick={onToggleInspector}
          title={inspectorOpen ? '收起 Inspector (⌘B)' : '展开 Inspector (⌘B)'}
          aria-label="切换 Inspector"
          aria-pressed={inspectorOpen}
          className="hidden h-8 w-8 items-center justify-center text-term-muted transition-colors hover:bg-term-hover hover:text-term-text lg:flex"
        >
          <PanelRight className={cn('h-[18px] w-[18px]', inspectorOpen && 'text-term-text')} />
        </button>

        <span className="mx-1 hidden h-5 w-px bg-term-border sm:block" />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-testid="terminal-header-user"
              className="flex h-8 items-center gap-1.5 px-1.5 text-sm text-term-muted transition-colors hover:bg-term-hover hover:text-term-text"
            >
              <UserRound className="h-[18px] w-[18px]" />
              <span className="hidden max-w-24 truncate sm:inline">{displayName}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="min-w-32 rounded-none border-term-border bg-term-panel text-term-text"
          >
            <DropdownMenuItem
              className="rounded-none text-sm focus:bg-term-hover focus:text-term-text"
              onClick={() => window.dispatchEvent(new CustomEvent(OPEN_SEARCH_EVENT))}
            >
              全局搜索
              <kbd className="ml-auto border border-term-border px-1 font-mono text-xs text-term-faint">
                ⌘K
              </kbd>
            </DropdownMenuItem>
            <DropdownMenuSeparator className="bg-term-border" />
            <DropdownMenuItem asChild className="rounded-none text-sm focus:bg-term-hover focus:text-term-text">
              <RouteLoadingLink href="/dashboard/profile">个人中心</RouteLoadingLink>
            </DropdownMenuItem>
            <DropdownMenuItem asChild className="rounded-none text-sm focus:bg-term-hover focus:text-term-text">
              <RouteLoadingLink href="/dashboard/change-password">修改密码</RouteLoadingLink>
            </DropdownMenuItem>
            <DropdownMenuSeparator className="bg-term-border" />
            <DropdownMenuItem
              className="rounded-none text-sm focus:bg-term-hover focus:text-term-text"
              onClick={() => window.dispatchEvent(new CustomEvent('believeboy:logout'))}
            >
              <LogOut className="mr-1 h-3.5 w-3.5" /> 退出登录
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
