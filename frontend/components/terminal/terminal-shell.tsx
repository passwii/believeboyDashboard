'use client'

import * as React from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { ChevronDown } from 'lucide-react'

import { PageTransition } from '@/components/motion/PageTransition'
import { RouteLoadingLink } from '@/components/dashboard/route-loading-link'
import { SearchCommand } from '@/components/dashboard/search-command'
import { TerminalGlobalFilterProvider } from '@/components/terminal/global-filter-context'
import {
  TerminalHeaderSlotProvider,
} from '@/components/terminal/terminal-header-slot'
import { TerminalFooter } from '@/components/terminal/terminal-footer'
import { TerminalHeader } from '@/components/terminal/terminal-header'
import { TerminalInspector } from '@/components/terminal/terminal-inspector'
import { useLiveStream } from '@/components/terminal/use-live-stream'
import { TerminalRail } from '@/components/terminal/terminal-rail'
import { TerminalSubnav } from '@/components/terminal/terminal-subnav'
import {
  pushRecent,
} from '@/components/terminal/terminal-constants'
import { useTerminalLayout } from '@/components/terminal/use-terminal-layout'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { getDashboardPageTitle } from '@/lib/dashboard-route-meta'
import {
  SIDEBAR_TOP_GROUPS,
  findGroupByPathname,
  getVisibleGroups,
  isLinkActive,
  type RoleType,
  type SidebarTopGroup,
} from '@/lib/sidebar-config'

interface TerminalShellProps {
  children: React.ReactNode
}

/**
 * Terminal 高密度交易终端外壳（BLF-809；BLF-887 高度上档 2026-08-29）。
 *
 * 桌面（md+）：L1 主轨 64px + L2 子导航 224px（可折叠）+ Top Header 56px +
 * Main Canvas（#main-content 独立滚动，document 不滚动）+ Right Inspector 360px
 * （⌘B 开关）+ Global Footer 36px。
 *
 * 移动端（<md）：L1/L2 收起为左侧 Sheet 抽屉；Footer 隐藏；Canvas 单列。
 */
export function TerminalShell({ children }: TerminalShellProps) {
  const pathname = usePathname()
  const router = useRouter()
  const { data: session } = useSession()
  const roleType = session?.user?.roleType as RoleType | undefined

  const visibleGroups = React.useMemo(
    () => getVisibleGroups(SIDEBAR_TOP_GROUPS, roleType),
    [roleType]
  )
  const activeGroupId = React.useMemo(() => findGroupByPathname(visibleGroups, pathname), [
    pathname,
    visibleGroups,
  ])

  const { subnavCollapsed, toggleSubnav, inspectorOpen, toggleInspector } = useTerminalLayout()

  // BLF-839：今日出单流——仅 Inspector 打开时轮询，传入插槽点亮
  const liveStreamItems = useLiveStream(inspectorOpen)

  // 最近访问记录：路由变化即写入 localStorage，供 Inspector 展示
  React.useEffect(() => {
    if (pathname === '/dashboard') return
    pushRecent(pathname, getDashboardPageTitle(pathname))
  }, [pathname])

  // Rail 点击域图标 → 跳到该域第一个模块；若子导航已折叠则顺手展开
  const handleGroupNavigate = React.useCallback(
    (group: SidebarTopGroup) => {
      if (subnavCollapsed) toggleSubnav()
      const target = group.items[0]
      if (target && !isLinkActive(pathname, target)) router.push(target.url)
    },
    [pathname, router, subnavCollapsed, toggleSubnav]
  )

  // 移动端抽屉
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false)
  const openMobileNav = React.useCallback(() => setMobileNavOpen(true), [])

  return (
    <TerminalGlobalFilterProvider>
      <TerminalHeaderSlotProvider>
      <div className="flex h-dvh w-full overflow-hidden rounded-none bg-term-bg text-[15px] leading-normal text-term-text shadow-none supports-[height:100dvh]:h-dvh">
      <TerminalRail
        groups={visibleGroups}
        activeGroupId={activeGroupId}
        onGroupNavigate={handleGroupNavigate}
      />

      {/* L2 常驻挂载：折叠/展开由组件内部做宽度过渡（BLF-825），避免硬卸载跳变 */}
      <div className="hidden h-full md:flex">
        <TerminalSubnav
          groups={visibleGroups}
          activeGroupId={activeGroupId}
          pathname={pathname}
          collapsed={subnavCollapsed}
          onCollapse={toggleSubnav}
        />
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <TerminalHeader
          groups={visibleGroups}
          activeGroupId={activeGroupId}
          pathname={pathname}
          subnavCollapsed={subnavCollapsed}
          onExpandSubnav={toggleSubnav}
          inspectorOpen={inspectorOpen}
          onToggleInspector={toggleInspector}
          onOpenMobileNav={openMobileNav}
        />

        <div className="relative flex min-h-0 flex-1">
          <main
            id="main-content"
            className="dashboard-full-width relative min-w-0 flex-1 overflow-x-clip overflow-y-auto rounded-none p-1 shadow-none md:p-2 term-scroll"
          >
            <PageTransition>{children}</PageTransition>
          </main>
          <TerminalInspector
            open={inspectorOpen}
            onClose={toggleInspector}
            liveStreamItems={liveStreamItems}
          />
        </div>

        <TerminalFooter />
      </div>

      {/* 全局命令面板（⌘K） */}
      <SearchCommand />

      {/* 移动端导航抽屉（<md）：入口在 Header 左侧汉堡按钮 */}
      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="flex w-[300px] flex-col rounded-none border-term-border bg-term-panel p-0 text-term-text">
          <SheetHeader className="shrink-0 border-b border-term-border px-3 py-2">
            <SheetTitle className="text-sm">导航菜单</SheetTitle>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain rounded-none px-2 py-2 term-scroll">
            {visibleGroups.map((group) => (
              <MobileGroupSection
                key={group.id}
                group={group}
                pathname={pathname}
                onNavigate={() => setMobileNavOpen(false)}
              />
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </div>
    </TerminalHeaderSlotProvider>
    </TerminalGlobalFilterProvider>
  )
}

/**
 * 移动端抽屉中的分组折叠列表。
 */
function MobileGroupSection({
  group,
  pathname,
  onNavigate,
}: {
  group: SidebarTopGroup
  pathname: string
  onNavigate: () => void
}) {
  const [open, setOpen] = React.useState(true)

  return (
    <div className="border border-term-border bg-term-panel">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2 py-2 text-left"
      >
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{group.label}</span>
        <span className="font-mono text-xs text-term-faint">{group.items.length}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-term-faint transition-transform ${open ? '' : '-rotate-90'}`}
        />
      </button>
      {open && (
        <nav className="flex flex-col border-t border-term-border">
          {group.items.map((item) => {
            const isActive = isLinkActive(pathname, item)
            return (
              <RouteLoadingLink
                key={item.url}
                href={item.url}
                onClick={onNavigate}
                className={`flex h-10 items-center gap-2 px-3 text-sm transition-colors ${
                  isActive ? 'bg-term-raised text-term-text' : 'text-term-muted hover:bg-term-hover'
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
              </RouteLoadingLink>
            )
          })}
        </nav>
      )}
    </div>
  )
}
