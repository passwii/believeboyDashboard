'use client'

import { PanelLeftClose, Search } from 'lucide-react'

import { RouteLoadingLink } from '@/components/dashboard/route-loading-link'
import { OPEN_SEARCH_EVENT } from '@/components/dashboard/search-command'
import { TERMINAL_SUBNAV_WIDTH, isItemActive } from '@/components/terminal/terminal-constants'
import type { SidebarTopGroup } from '@/lib/sidebar-config'
import { cn } from '@/lib/utils'

interface TerminalSubnavProps {
  groups: SidebarTopGroup[]
  activeGroupId?: string
  pathname: string
  onCollapse: () => void
}

/**
 * L2 模块抽屉（200px，BLF-809）：当前域的子模块导航 + ⌘K 搜索入口。
 * 活动项以左侧 2px accent 条 + raised 底色标识；折叠由外层 shell 直接摘除本列。
 */
export function TerminalSubnav({ groups, activeGroupId, pathname, onCollapse }: TerminalSubnavProps) {
  const activeGroup = groups.find((g) => g.id === activeGroupId) ?? groups[0]

  return (
    <aside
      style={{ width: TERMINAL_SUBNAV_WIDTH }}
      className="hidden h-full shrink-0 flex-col border-r border-term-border bg-term-panel md:flex"
    >
      {/* 组头：域名 + 折叠按钮 */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-term-border pl-3 pr-1">
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wider text-term-muted">
          {activeGroup?.label ?? '导航'}
        </span>
        <button
          type="button"
          onClick={onCollapse}
          title="折叠侧栏"
          aria-label="折叠侧栏"
          className="flex h-6 w-6 items-center justify-center text-term-faint transition-colors hover:bg-term-hover hover:text-term-text"
        >
          <PanelLeftClose className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* ⌘K 搜索入口 */}
      <div className="shrink-0 p-2">
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent(OPEN_SEARCH_EVENT))}
          className="flex h-7 w-full items-center gap-1.5 border border-term-border bg-term-raised px-2 text-term-muted transition-colors hover:border-term-border-strong hover:text-term-text"
        >
          <Search className="h-3 w-3" />
          <span className="flex-1 text-left text-xs">搜索…</span>
          <kbd className="border border-term-border px-1 font-mono text-[10px] leading-4 text-term-faint">
            ⌘K
          </kbd>
        </button>
      </div>

      {/* 子模块列表 */}
      <nav className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-2 term-scroll">
        {(activeGroup?.items ?? []).map((item) => {
          const ItemIcon = item.icon ?? activeGroup.icon
          const isActive = isItemActive(item, pathname)
          return (
            <RouteLoadingLink
              key={item.url}
              href={item.url}
              className={cn(
                'relative flex h-[26px] shrink-0 items-center gap-2 pl-[10px] pr-2 text-xs transition-colors',
                isActive
                  ? 'bg-term-raised text-term-text'
                  : 'text-term-muted hover:bg-term-hover hover:text-term-text'
              )}
            >
              {isActive && (
                <span className="absolute left-0 top-0 h-full w-0.5 bg-term-accent" />
              )}
              <ItemIcon className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
              <span className="min-w-0 flex-1 truncate">{item.title}</span>
              {item.badge ? <item.badge /> : null}
            </RouteLoadingLink>
          )
        })}
      </nav>
    </aside>
  )
}
