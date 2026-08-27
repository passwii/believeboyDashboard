'use client'

import * as React from 'react'
import { useSession } from 'next-auth/react'
import { Bell, Loader2, LogOut, Menu, PanelLeft, PanelRight, RefreshCcw, Search, UserRound } from 'lucide-react'

import { RouteLoadingLink } from '@/components/dashboard/route-loading-link'
import { OPEN_SEARCH_EVENT } from '@/components/dashboard/search-command'
import { TermKbd } from '@/components/terminal/term-kbd'
import {
  TERMINAL_HEADER_HEIGHT,
} from '@/components/terminal/terminal-constants'
import {
  HeaderCountrySelect,
  HeaderDateRangePicker,
  HeaderProjectSelect,
} from '@/components/terminal/header-filter-suite'
import {
  HeaderSlotMount,
  useTerminalHeaderSlot,
} from '@/components/terminal/terminal-header-slot'
import {
  isGlobalFilterPilotRoute,
  useTerminalGlobalFilter,
} from '@/components/terminal/global-filter-context'
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
 * 中：HeaderSlot 唯一操作区 + 全局筛选四件套（BLF-819，仅试点路由激活；BLF-874 已移除 KPI 磁贴）。
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

  // BLF-826 全局刷新按钮：页面经 useHeaderRefresh 注册回调；无注册时隐藏。
  const { refreshRegistered, refreshLoading, triggerRefresh } = useTerminalHeaderSlot()

  // BLF-819 全局筛选四件套：仅试点路由渲染，其余页面头部行为零变化
  // BLF-874 Stage 1：KPI 磁贴（GMV/ORD/PND）已下线，正文 MetricSwitcherCard 已覆盖，移除 useHeaderKpis 依赖
  const globalFilter = useTerminalGlobalFilter()
  const pilotActive = isGlobalFilterPilotRoute(pathname)

  const activeGroup = groups.find((g) => g.id === activeGroupId)
  const pageTitle = React.useMemo(() => getDashboardPageTitle(pathname), [pathname])
  const displayName = user?.name || 'User'

  return (
    <header
      style={{ height: TERMINAL_HEADER_HEIGHT }}
      className="flex shrink-0 items-stretch rounded-none border-b border-term-border bg-term-panel shadow-none"
    >
      {/* 左段：subnav 切换 + 面包屑（BLF-874：flex-1 min-w-0 + overflow-x-auto term-scroll，超宽横向滚动不挤占中/右） */}
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-2 term-scroll">
        <button
          type="button"
          onClick={onOpenMobileNav}
          title="导航菜单"
          aria-label="打开导航菜单"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-none text-term-muted shadow-none transition-colors hover:bg-term-hover hover:text-term-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-term-accent md:hidden"
        >
          <Menu className="h-[18px] w-[18px]" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          onClick={onExpandSubnav}
          title={subnavCollapsed ? '展开侧栏' : '侧栏'}
          aria-label={subnavCollapsed ? '展开侧栏' : '侧栏'}
          className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-none text-term-muted shadow-none transition-colors hover:bg-term-hover hover:text-term-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-term-accent md:flex"
        >
          <PanelLeft className={cn('h-[18px] w-[18px]', !subnavCollapsed && 'text-term-text')} strokeWidth={1.75} />
        </button>
        <nav aria-label="面包屑" className="flex min-w-0 shrink-0 items-center gap-1.5 text-sm">
          {activeGroup && (
            <>
              <span
                className="shrink-0 uppercase tracking-wider text-term-faint transition-colors hover:text-term-muted"
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

      {/* 中段：页面级 HeaderSlot 唯一容器（BLF-874/826，hidden md:flex gap-1.5 overflow-hidden 48px 对齐） */}
      <HeaderSlotMount className="hidden min-w-0 shrink items-center gap-1.5 overflow-hidden rounded-none border-l border-term-border px-2 md:flex" />
      {pilotActive && globalFilter.ready ? (
        <div className="hidden shrink-0 items-center gap-1.5 overflow-x-auto rounded-none border-l border-term-border px-2 term-scroll xl:flex">
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
        </div>
      ) : null}

      {/* 右段：全局刷新 / 搜索 / 通知 / Inspector / 用户 */}
      <div className="flex shrink-0 items-center gap-1 px-2">
        {refreshRegistered && (
          <button
            type="button"
            onClick={triggerRefresh}
            disabled={refreshLoading}
            title="刷新当前页数据（强刷跳缓存）"
            aria-label="刷新当前页数据"
            data-testid="terminal-header-refresh"
            className="relative flex h-8 w-8 items-center justify-center rounded-none text-term-muted shadow-none transition-colors hover:bg-term-hover hover:text-term-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-term-accent disabled:pointer-events-none disabled:opacity-50"
          >
            <RefreshCcw className="h-[18px] w-[18px]" strokeWidth={1.75} />
            {refreshLoading && (
              <Loader2 className="absolute h-[18px] w-[18px] animate-spin" strokeWidth={1.75} aria-hidden />
            )}
          </button>
        )}
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent(OPEN_SEARCH_EVENT))}
          title="全局搜索"
          aria-label="全局搜索"
          className="flex h-8 items-center gap-1 rounded-none px-1.5 text-term-muted shadow-none transition-colors hover:bg-term-hover hover:text-term-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-term-accent"
        >
          <Search className="h-[18px] w-[18px]" strokeWidth={1.75} />
        </button>

        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              onClick={() => void refresh()}
              title="通知"
              aria-label={`通知${unreadCount > 0 ? `，${unreadCount} 条未读` : ''}`}
              className="relative flex h-8 w-8 items-center justify-center rounded-none text-term-muted shadow-none transition-colors hover:bg-term-hover hover:text-term-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-term-accent"
            >
              <Bell className="h-[18px] w-[18px]" strokeWidth={1.75} />
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
          className="hidden h-8 w-8 items-center justify-center rounded-none text-term-muted shadow-none transition-colors hover:bg-term-hover hover:text-term-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-term-accent lg:flex"
        >
          <PanelRight className={cn('h-[18px] w-[18px]', inspectorOpen && 'text-term-text')} strokeWidth={1.75} />
        </button>

        <span className="mx-1 hidden h-5 w-px bg-term-border sm:block" />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-testid="terminal-header-user"
              className="flex h-8 items-center gap-1.5 rounded-none px-1.5 text-sm text-term-muted shadow-none transition-colors hover:bg-term-hover hover:text-term-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-term-accent"
            >
              <UserRound className="h-[18px] w-[18px]" strokeWidth={1.75} />
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
              <TermKbd className="ml-auto">⌘K</TermKbd>
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
              <LogOut className="mr-1 h-4 w-4" strokeWidth={1.75} /> 退出登录
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
