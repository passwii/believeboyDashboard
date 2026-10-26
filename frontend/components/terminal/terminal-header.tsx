'use client'

import * as React from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import {
  AlertCircle,
  Bell,
  ChevronDown,
  Check,
  Loader2,
  LogOut,
  Menu,
  PanelLeft,
  PanelRight,
  RefreshCcw,
  Search,
  UserRound,
} from 'lucide-react'

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
  PrimaryFilterSlotMount,
  SecondaryHeaderSlotMount,
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
import { formatDisplayName, pickSessionDisplayName } from '@/lib/auth/display-name'
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
 * BLF-881：未注册页兜底刷新的看门狗时长（与 RouteLoadingLink 的
 * NAVIGATION_LOADING_WATCHDOG_MS 对齐）。router.refresh() 无完成回调，
 * useTransition 的 pending 覆盖正常完成路径；看门狗兜底防止按钮卡死在 loading。
 */
const FALLBACK_REFRESH_WATCHDOG_MS = 10_000

/**
 * Top Header: a fixed navigation/action row, a persistent project/date row,
 * and an optional secondary filter row.
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

  // BLF-826 全局刷新按钮：页面经 useHeaderRefresh 注册回调。
  // BLF-881 全页面常驻：未注册页兜底 router.refresh()（重取当前路由 server 数据、不丢 client state）。
  const {
    refreshRegistered,
    refreshLoading,
    refreshHandlerPending,
    refreshFeedback,
    announceRefresh,
    triggerRefresh,
    primaryFilterSlotActive,
    secondarySlotActive,
  } = useTerminalHeaderSlot()
  const router = useRouter()
  const [fallbackPending, startFallbackRefresh] = React.useTransition()
  const [fallbackTimedOut, setFallbackTimedOut] = React.useState(false)
  const fallbackRefreshStartedRef = React.useRef(false)

  React.useEffect(() => {
    announceRefresh('', 'idle')
  }, [announceRefresh, pathname])

  React.useEffect(() => {
    if (!fallbackPending) {
      setFallbackTimedOut(false)
      return
    }
    const timer = setTimeout(() => setFallbackTimedOut(true), FALLBACK_REFRESH_WATCHDOG_MS)
    return () => clearTimeout(timer)
  }, [fallbackPending])

  const fallbackLoading = fallbackPending && !fallbackTimedOut
  const refreshActive = refreshRegistered
    ? refreshLoading || refreshHandlerPending
    : fallbackLoading

  const handleRefreshClick = React.useCallback(() => {
    if (refreshRegistered) {
      triggerRefresh()
      return
    }
    fallbackRefreshStartedRef.current = true
    announceRefresh('正在刷新当前页。', 'loading')
    startFallbackRefresh(() => {
      router.refresh()
    })
  }, [announceRefresh, refreshRegistered, triggerRefresh, startFallbackRefresh, router])

  React.useEffect(() => {
    if (refreshRegistered || fallbackPending || !fallbackRefreshStartedRef.current) return
    fallbackRefreshStartedRef.current = false
    announceRefresh('刷新请求已返回；请确认页面内容已更新。', 'requested')
  }, [announceRefresh, fallbackPending, fallbackTimedOut, refreshRegistered])

  React.useEffect(() => {
    if (!fallbackTimedOut || refreshRegistered) return
    announceRefresh('刷新仍在后台进行，页面响应后会自动更新。', 'requested')
  }, [announceRefresh, fallbackTimedOut, refreshRegistered])

  // BLF-819 全局筛选四件套：仅试点路由渲染，其余页面头部行为零变化
  // BLF-874 Stage 1：KPI 磁贴（GMV/ORD/PND）已下线，正文 MetricSwitcherCard 已覆盖，移除 useHeaderKpis 依赖
  const globalFilter = useTerminalGlobalFilter()
  const pilotActive = isGlobalFilterPilotRoute(pathname)
  const [secondaryFiltersExpanded, setSecondaryFiltersExpanded] = React.useState(false)
  const hasGlobalPrimaryFilters = pilotActive && globalFilter.ready
  const hasGlobalSecondaryFilters = pilotActive && globalFilter.ready
  const hasPrimaryFilters = hasGlobalPrimaryFilters || primaryFilterSlotActive
  const hasSecondaryFilters = hasGlobalSecondaryFilters || secondarySlotActive

  React.useEffect(() => {
    setSecondaryFiltersExpanded(false)
  }, [pathname])

  const activeGroup = groups.find((g) => g.id === activeGroupId)
  const pageTitle = React.useMemo(() => getDashboardPageTitle(pathname), [pathname])
  // BLF-1441：顶部用户名 = user_accounts.full_name（无姓名时显示「未命名」，
  // 不回落登录名）。规则见 lib/auth/display-name.ts。
  const displayName = user ? formatDisplayName(pickSessionDisplayName(user)) : 'User'

  return (
    <header className="flex shrink-0 flex-col rounded-none border-b border-term-border bg-term-panel shadow-none">
      <div
        data-testid="terminal-header-primary-row"
        style={{ height: TERMINAL_HEADER_HEIGHT }}
        className="flex shrink-0 items-stretch"
      >
        {/* 左段：subnav 切换 + 面包屑（宽度不足时在自身横向滚动，不挤占中/右） */}
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-2 term-scroll">
        <button
          type="button"
          onClick={onOpenMobileNav}
          title="导航菜单"
          aria-label="打开导航菜单"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-none text-term-muted shadow-none transition-colors hover:bg-term-hover hover:text-term-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-term-accent md:hidden"
        >
          <Menu className="h-5 w-5" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          onClick={onExpandSubnav}
          title={subnavCollapsed ? '展开侧栏' : '侧栏'}
          aria-label={subnavCollapsed ? '展开侧栏' : '侧栏'}
          className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-none text-term-muted shadow-none transition-colors hover:bg-term-hover hover:text-term-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-term-accent md:flex"
        >
          <PanelLeft className={cn('h-5 w-5', !subnavCollapsed && 'text-term-text')} strokeWidth={1.75} />
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

        {/* 页面操作插槽保持在导航/操作行，不与常驻筛选共享可裁切区域。 */}
        <HeaderSlotMount className="hidden min-w-0 shrink flex-nowrap items-center gap-1.5 overflow-hidden rounded-none border-l border-term-border px-2 md:flex" />

        {/* 右段：次级筛选展开 / 全局刷新 / 搜索 / 通知 / Inspector / 用户 */}
        <div className="flex shrink-0 items-center gap-1 px-2">
          {hasSecondaryFilters ? (
            <button
              type="button"
              onClick={() => setSecondaryFiltersExpanded((expanded) => !expanded)}
              title={secondaryFiltersExpanded ? '收起次级筛选' : '展开次级筛选'}
              aria-label={secondaryFiltersExpanded ? '收起次级筛选' : '展开次级筛选'}
              aria-expanded={secondaryFiltersExpanded}
              aria-controls="terminal-header-secondary-row"
              data-testid="terminal-header-secondary-toggle"
              className={cn(
                'flex h-9 w-9 shrink-0 items-center justify-center rounded-none text-term-muted shadow-none transition-colors hover:bg-term-hover hover:text-term-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-term-accent',
                !secondarySlotActive && 'hidden xl:flex'
              )}
            >
              <ChevronDown
                aria-hidden
                className={cn(
                  'h-5 w-5 transition-transform motion-reduce:transition-none',
                  secondaryFiltersExpanded && 'rotate-180'
                )}
                strokeWidth={1.75}
              />
            </button>
          ) : null}
        {/* BLF-881：全页面常驻——已注册页触发页面回调（强刷跳缓存），未注册页兜底 router.refresh() */}
        <button
          type="button"
          onClick={handleRefreshClick}
          disabled={refreshActive}
          title={refreshFeedback.message || (refreshRegistered ? '刷新当前页数据（强刷跳缓存）' : '刷新当前页（重取服务端数据）')}
          aria-label="刷新当前页数据"
          aria-busy={refreshActive}
          data-testid="terminal-header-refresh"
          className={cn(
            'relative flex h-9 w-9 items-center justify-center rounded-none text-term-muted shadow-none transition-colors hover:bg-term-hover hover:text-term-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-term-accent disabled:pointer-events-none disabled:opacity-50',
            !refreshActive && refreshFeedback.status === 'success' && 'text-term-pos',
            !refreshActive && refreshFeedback.status === 'error' && 'text-term-neg',
            !refreshActive && refreshFeedback.status === 'requested' && 'text-term-accent'
          )}
        >
          {refreshActive ? (
            <Loader2
              className="h-5 w-5 animate-spin motion-reduce:animate-none"
              strokeWidth={1.75}
              aria-hidden
            />
          ) : refreshFeedback.status === 'success' ? (
            <Check className="h-5 w-5" strokeWidth={1.75} aria-hidden />
          ) : refreshFeedback.status === 'error' ? (
            <AlertCircle className="h-5 w-5" strokeWidth={1.75} aria-hidden />
          ) : (
            <RefreshCcw className="h-5 w-5" strokeWidth={1.75} aria-hidden />
          )}
        </button>
        <span
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="sr-only"
          data-testid="terminal-header-refresh-status"
        >
          {refreshFeedback.message}
        </span>
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent(OPEN_SEARCH_EVENT))}
          title="全局搜索"
          aria-label="全局搜索"
          className="flex h-9 items-center gap-1 rounded-none px-1.5 text-term-muted shadow-none transition-colors hover:bg-term-hover hover:text-term-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-term-accent"
        >
          <Search className="h-5 w-5" strokeWidth={1.75} />
        </button>

        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              onClick={() => void refresh()}
              title="通知"
              aria-label={`通知${unreadCount > 0 ? `，${unreadCount} 条未读` : ''}`}
              className="relative flex h-9 w-9 items-center justify-center rounded-none text-term-muted shadow-none transition-colors hover:bg-term-hover hover:text-term-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-term-accent"
            >
              <Bell className="h-5 w-5" strokeWidth={1.75} />
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
          className="hidden h-9 w-9 items-center justify-center rounded-none text-term-muted shadow-none transition-colors hover:bg-term-hover hover:text-term-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-term-accent lg:flex"
        >
          <PanelRight className={cn('h-5 w-5', inspectorOpen && 'text-term-text')} strokeWidth={1.75} />
        </button>

        <span className="mx-1 hidden h-5 w-px bg-term-border sm:block" />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-testid="terminal-header-user"
              aria-label={`用户菜单：${displayName}`}
              className="flex h-9 items-center gap-1.5 rounded-none px-1.5 text-sm text-term-muted shadow-none transition-colors hover:bg-term-hover hover:text-term-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-term-accent"
            >
              <UserRound className="h-5 w-5" strokeWidth={1.75} />
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
      </div>
      {hasPrimaryFilters ? (
        <div
          data-testid="terminal-header-primary-filter-row"
          className={cn(
            'w-full border-t border-term-border bg-term-panel',
            hasGlobalPrimaryFilters && !primaryFilterSlotActive && 'hidden xl:block'
          )}
        >
          <PrimaryFilterSlotMount className="flex min-w-0 items-center gap-1.5 overflow-x-auto px-2 py-1 term-scroll">
            {hasGlobalPrimaryFilters ? (
              <div
                data-testid="terminal-header-primary-global-filters"
                className="hidden shrink-0 items-center gap-1.5 xl:flex"
              >
                <HeaderProjectSelect
                  value={globalFilter.projectId}
                  onChange={globalFilter.setProjectId}
                />
                <HeaderDateRangePicker
                  dateFrom={globalFilter.dateFrom}
                  dateTo={globalFilter.dateTo}
                  country={globalFilter.country}
                  onChange={globalFilter.setDateRange}
                />
              </div>
            ) : null}
          </PrimaryFilterSlotMount>
        </div>
      ) : null}
      <div
        id="terminal-header-secondary-row"
        data-testid="terminal-header-secondary-row"
        hidden={!secondaryFiltersExpanded}
        className={cn(
          'w-full border-t border-term-border bg-term-panel',
          !secondaryFiltersExpanded && 'hidden',
          hasGlobalSecondaryFilters && !secondarySlotActive && 'hidden xl:block'
        )}
      >
        {secondaryFiltersExpanded ? (
          <SecondaryHeaderSlotMount className="flex min-h-11 min-w-0 flex-wrap items-center gap-1.5 px-2 py-1">
            {hasGlobalSecondaryFilters ? (
              <div className="hidden items-center gap-1.5 xl:flex">
                <HeaderCountrySelect
                  value={globalFilter.country}
                  onChange={globalFilter.setCountry}
                />
              </div>
            ) : null}
          </SecondaryHeaderSlotMount>
        ) : null}
      </div>
    </header>
  )
}
