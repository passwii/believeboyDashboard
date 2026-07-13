'use client'

import * as React from 'react'
import Link from 'next/link'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import type { SidebarTopGroup, RoleType } from '@/lib/sidebar-config'
import { cn } from '@/lib/utils'

interface SidebarIconRailProps {
  groups: SidebarTopGroup[]
  activeGroupId: string | null
  pinnedGroupId: string | null
  /**
   * 由父组件一次性计算后注入；key 为 group.id，value 表示该 group 内是否有当前路由命中的 item。
   * 这样 SidebarIconRail 不必订阅 usePathname()，避免在每次路由切换时 re-render 整个 rail。
   */
  pathnameMatchByGroupId: Record<string, boolean>
  /**
   * 由父组件通过 useMemo 预生成的 hover handler 映射（key 为 group.id）。
   * 给 chip 提供稳定引用，配合 React.memo 的自定义 comparator 跳过不必要 commit。
   */
  onHoverEnterByGroupId: Record<string, () => void>
  onUserHoverEnter: () => void
  user: {
    name: string
    email: string
    avatar?: string
    roleType?: RoleType
  }
}

interface RailChipProps {
  group: SidebarTopGroup
  isActive: boolean
  isPinned: boolean
  hasActiveItem: boolean
  onHoverEnter: () => void
}

const USER_CHIP_ACCENT =
  'bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-950/40 dark:to-indigo-950/40 text-blue-600 dark:text-blue-400'
const USER_CHIP_ACTIVE_ACCENT =
  'bg-gradient-to-br from-blue-100 to-indigo-100 dark:from-blue-900/50 dark:to-indigo-900/50 text-blue-700 dark:text-blue-300'

/**
 * 1 个一级 group chip：纯展示，hover 触发 panel。
 *
 * 性能要点：
 * - React.memo + 自定义 comparator：只有当 isActive / isPinned / hasActiveItem 变化时才重渲染。
 * - group / onHoverEnter 来自父级 useMemo 稳定后的引用，浅比较即可正常工作；
 *   这里仍用自定义比较以防父级意外传入新引用时仍能正确跳过。
 */
const RailChip = React.memo(
  function RailChip({ group, isActive, isPinned, hasActiveItem, onHoverEnter }: RailChipProps) {
    const Icon = group.icon
    return (
      <button
        type="button"
        data-active={isActive}
        data-pinned={isPinned}
        data-has-active={hasActiveItem}
        onMouseEnter={onHoverEnter}
        aria-label={group.label}
        aria-expanded={isActive}
        aria-controls="sidebar-panel"
        title={group.label}
        className={cn(
          'group/icon flex h-11 w-11 shrink-0 items-center justify-center rounded-[0.85rem] border border-[hsl(var(--sidebar-foreground)/0.08)] shadow-[inset_0_1px_0_hsl(var(--sidebar-foreground)/0.06)] transition-all duration-200 ease-out',
          'hover:scale-[1.04] hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
          hasActiveItem ? group.activeAccent : group.accent,
          isActive &&
            'ring-2 ring-primary/30 transition-[transform,opacity,background-color] duration-200 ease-[cubic-bezier(0.22,1.18,0.36,1)]'
        )}
      >
        <Icon
          className={cn(
            'h-5 w-5 transition-all',
            !hasActiveItem && 'grayscale-[40%] group-hover/icon:grayscale-0'
          )}
        />
      </button>
    )
  },
  (prev, next) =>
    prev.group === next.group &&
    prev.isActive === next.isActive &&
    prev.isPinned === next.isPinned &&
    prev.hasActiveItem === next.hasActiveItem &&
    prev.onHoverEnter === next.onHoverEnter
)

/**
 * User chip：和 7 个一级 chip 同款（h-11 w-11 rounded-[0.85rem] 圆角方块），
 * 用柔和蓝色渐变与 nav chip 区分，体现"个人身份"。
 * 内部嵌入 avatar（蓝紫渐变圆形）+ 首字 fallback。
 */
const UserChip = React.memo(
  function UserChip({
    user,
    isActive,
    isPinned,
    onHoverEnter,
  }: {
    user: SidebarIconRailProps['user']
    isActive: boolean
    isPinned: boolean
    onHoverEnter: () => void
  }) {
    const fallback = React.useMemo(() => {
      if (!user.name) return 'U'
      const first = [...user.name.trim()].find((c) => /[\p{L}\p{N}]/u.test(c))
      return first ? first.toUpperCase() : 'U'
    }, [user.name])

    return (
      <button
        type="button"
        data-active={isActive}
        data-pinned={isPinned}
        onMouseEnter={onHoverEnter}
        aria-label={`${user.name}，悬停查看账户信息`}
        aria-expanded={isActive}
        aria-controls="sidebar-user-panel"
        title={`${user.name} · 账户`}
        className={cn(
          'group/icon flex h-11 w-11 shrink-0 items-center justify-center rounded-[0.85rem] border border-blue-200/60 dark:border-blue-800/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] transition-all duration-200 ease-out',
          'hover:scale-[1.04] hover:shadow-md hover:border-blue-300/80 dark:hover:border-blue-700/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
          isActive || isPinned ? USER_CHIP_ACTIVE_ACCENT : USER_CHIP_ACCENT,
          isActive &&
            'ring-2 ring-primary/30 transition-[transform,opacity,background-color] duration-200 ease-[cubic-bezier(0.22,1.18,0.36,1)]'
        )}
      >
        <Avatar className="h-7 w-7">
          <AvatarImage src={user.avatar} alt={user.name} />
          <AvatarFallback className="bg-gradient-to-br from-blue-400 to-indigo-500 dark:from-blue-500 dark:to-indigo-600 text-[0.85rem] font-semibold tracking-tight text-white shadow-sm">
            {fallback}
          </AvatarFallback>
        </Avatar>
      </button>
    )
  },
  (prev, next) =>
    prev.user === next.user &&
    prev.isActive === next.isActive &&
    prev.isPinned === next.isPinned &&
    prev.onHoverEnter === next.onHoverEnter
)

/**
 * 外层 68px 固定窄栏：Logo + 7 个 group icon + 底部 user chip。
 *
 * 行为说明：
 * - 一级 chip 不绑 onClick（纯 hover 触发 panel），鼠标 hover 才打开 panel。
 * - rail 外层不挂 onMouseLeave，统一由 sidebar-shell 的 wrapper 处理。
 * - 底部 user chip 复用同一套 hover 行为，触发 'user' 虚拟 group id，展开 240px
 *   SidebarUserPanel（与 7 个 group 走同一套 panelState 状态机）。
 * - 不再调用 usePathname()：是否高亮由父级注入的 pathnameMatchByGroupId 决定，
 *   配合 React.memo 包裹的 RailChip/UserChip，确保路由切换时只有当前 group 的 chip 提交。
 */
export const SidebarIconRail = React.memo(function SidebarIconRail({
  groups,
  activeGroupId,
  pinnedGroupId,
  pathnameMatchByGroupId,
  onHoverEnterByGroupId,
  onUserHoverEnter,
  user,
}: SidebarIconRailProps) {
  return (
    <div className="sidebar-rail relative z-30 flex h-screen w-[68px] shrink-0 flex-col border-r border-[hsl(var(--sidebar-border))] bg-[hsl(var(--sidebar-background))]">
      {/* Logo */}
      <div className="flex h-[56px] shrink-0 items-center justify-center border-b border-[hsl(var(--sidebar-border))]/60">
        <Link
          href="/dashboard"
          className="group flex h-9 w-9 items-center justify-center rounded-[0.6rem] bg-gradient-to-br from-blue-500 to-indigo-600 text-sm font-bold text-white shadow-sm transition-transform hover:scale-105"
          title="BelieveBoy运营控制台"
          aria-label="BelieveBoy运营控制台"
        >
          BB
        </Link>
      </div>

      {/* Group icons */}
      <nav
        className="flex flex-1 flex-col items-center gap-2.5 overflow-x-hidden overflow-y-auto px-3 py-3"
        aria-label="主导航"
      >
        {groups.map((group) => (
          <RailChip
            key={group.id}
            group={group}
            isActive={activeGroupId === group.id}
            isPinned={pinnedGroupId === group.id}
            hasActiveItem={pathnameMatchByGroupId[group.id] === true}
            onHoverEnter={onHoverEnterByGroupId[group.id]}
          />
        ))}
      </nav>

      {/* User chip (bottom) — 第 8 个一级 chip，hover 触发 'user' 虚拟 group，展开 SidebarUserPanel */}
      <div className="shrink-0 flex justify-center border-t border-[hsl(var(--sidebar-border))]/60 px-2 pb-3 pt-2">
        <UserChip
          user={user}
          isActive={activeGroupId === 'user'}
          isPinned={pinnedGroupId === 'user'}
          onHoverEnter={onUserHoverEnter}
        />
      </div>
    </div>
  )
})
