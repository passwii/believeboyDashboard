'use client'

import * as React from 'react'
import { PanelLeftClose, Search } from 'lucide-react'

import { RouteLoadingLink } from '@/components/dashboard/route-loading-link'
import { OPEN_SEARCH_EVENT } from '@/components/dashboard/search-command'
import { TermKbd } from '@/components/terminal/term-kbd'
import {
  TERMINAL_SUBNAV_COLLAPSED_WIDTH,
  TERMINAL_SUBNAV_MOTION,
  TERMINAL_SUBNAV_WIDTH,
  TERMINAL_TOP_STRIP_HEIGHT,
  isItemActive,
} from '@/components/terminal/terminal-constants'
import type { SidebarTopGroup } from '@/lib/sidebar-config'
import { cn } from '@/lib/utils'

interface TerminalSubnavProps {
  groups: SidebarTopGroup[]
  activeGroupId?: string
  pathname: string
  collapsed: boolean
  onCollapse: () => void
}

/**
 * L2 模块抽屉（BLF-809；折叠动效 BLF-825）。
 *
 * 折叠 ↔ 展开为常驻挂载的宽度过渡（260ms ease-out-expo 类曲线）：
 * - 壳层 width 动画，Main Canvas 平滑跟随；
 * - 内容层（组头文字 / 搜索框 / 列表项）收缩时先淡出 + 轻微 translateX，
 *   展开时按 stagger 级联入场；激活指示条独立于内容层，过渡期不闪烁。
 */
export function TerminalSubnav({ groups, activeGroupId, pathname, collapsed, onCollapse }: TerminalSubnavProps) {
  const activeGroup = groups.find((g) => g.id === activeGroupId) ?? groups[0]
  const items = activeGroup?.items ?? []

  // 入场级联延迟：组头 0 → 搜索框 step → 列表项 step*2 起，封顶 maxStaggerDelayMs
  const delayOf = React.useCallback(
    (slot: number) =>
      Math.min(slot * TERMINAL_SUBNAV_MOTION.staggerStepMs, TERMINAL_SUBNAV_MOTION.maxStaggerDelayMs),
    []
  )

  const contentStyle = (slot: number): React.CSSProperties => ({ '--subnav-delay': `${delayOf(slot)}ms` } as React.CSSProperties)

  return (
    <aside
      style={{
        width: collapsed ? TERMINAL_SUBNAV_COLLAPSED_WIDTH : TERMINAL_SUBNAV_WIDTH,
        '--subnav-duration': `${TERMINAL_SUBNAV_MOTION.durationMs}ms`,
        '--subnav-ease': TERMINAL_SUBNAV_MOTION.ease,
        '--subnav-fade-out': `${TERMINAL_SUBNAV_MOTION.fadeOutMs}ms`,
        '--subnav-fade-in': `${TERMINAL_SUBNAV_MOTION.fadeInMs}ms`,
      } as React.CSSProperties}
      aria-hidden={collapsed}
      className={cn(
        'term-subnav-shell hidden h-full shrink-0 border-r border-term-border bg-term-panel md:flex',
        collapsed ? 'term-subnav-collapsed' : 'term-subnav-expanded'
      )}
    >
      {/* 内容层统一包裹：收缩时整体淡出，展开时级联入场 */}
      <div className="flex h-full min-w-0 flex-1 flex-col" style={{ minWidth: TERMINAL_SUBNAV_WIDTH }}>
        {/* 组头：域名 + 折叠按钮（高度 = 顶部基准带，BLF-832；BLF-825 动效类不动） */}
        <div className="term-subnav-content flex shrink-0 items-center gap-1 border-b border-term-border pl-3 pr-1" style={{ ...contentStyle(0), minWidth: TERMINAL_SUBNAV_WIDTH, height: TERMINAL_TOP_STRIP_HEIGHT }}>
          <span className="min-w-0 flex-1 truncate text-sm font-semibold uppercase tracking-wider text-term-muted">
            {activeGroup?.label ?? '导航'}
          </span>
          <button
            type="button"
            onClick={onCollapse}
            title="折叠侧栏"
            aria-label="折叠侧栏"
            aria-expanded={!collapsed}
            className="flex h-8 w-8 items-center justify-center text-term-faint transition-colors hover:bg-term-hover hover:text-term-text"
          >
            <PanelLeftClose className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </div>

        {/* ⌘K 搜索入口 */}
        <div className="term-subnav-content shrink-0 p-2" style={{ ...contentStyle(1), minWidth: TERMINAL_SUBNAV_WIDTH }}>
          <button
            type="button"
            tabIndex={collapsed ? -1 : undefined}
            onClick={() => window.dispatchEvent(new CustomEvent(OPEN_SEARCH_EVENT))}
            className="flex w-full h-9 items-center gap-2 border border-term-border bg-term-raised px-2.5 text-term-muted transition-colors hover:border-term-border-strong hover:text-term-text"
          >
            <Search className="h-4 w-4" strokeWidth={1.75} />
            <span className="flex-1 text-left text-sm">搜索…</span>
            <TermKbd>⌘K</TermKbd>
          </button>
        </div>

        {/* 子模块列表 */}
        <nav className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-2 term-scroll">
          {items.map((item, index) => {
            const ItemIcon = item.icon ?? activeGroup.icon
            const isActive = isItemActive(item, pathname)
            return (
              <RouteLoadingLink
                key={item.url}
                href={item.url}
                tabIndex={collapsed ? -1 : undefined}
                className={cn(
                  'term-subnav-content relative flex h-8 shrink-0 items-center gap-2 pl-3 pr-2 text-sm transition-colors',
                  isActive
                    ? 'bg-term-raised text-term-text'
                    : 'text-term-muted hover:bg-term-hover hover:text-term-text'
                )}
                style={{ ...contentStyle(index + 2), minWidth: TERMINAL_SUBNAV_WIDTH }}
              >
                {isActive && (
                  <span className="term-subnav-indicator absolute left-0 top-0 h-full w-0.5 bg-term-accent" />
                )}
                <ItemIcon className="h-4 w-4 shrink-0" strokeWidth={1.75} />
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                {item.badge ? <item.badge /> : null}
              </RouteLoadingLink>
            )
          })}
        </nav>
      </div>
    </aside>
  )
}
