'use client'

import * as React from 'react'
import { usePathname } from 'next/navigation'
import {
  ChevronRight,
  Pin,
  PinOff,
  X,
} from 'lucide-react'

import { RouteLoadingLink } from '@/components/dashboard/route-loading-link'
import { isLinkActive, type SidebarTopGroup } from '@/lib/sidebar-config'
import { cn } from '@/lib/utils'

interface SidebarPanelProps {
  group: SidebarTopGroup
  pinnedGroupId: string | null
  onClose: () => void
  onPinToggle: () => void
  onNavigate: () => void
}

/**
 * 内层 240px 弹出面板：
 * - 顶部：组标题 + 关闭按钮 + pin 按钮（锁定当前面板）
 * - 中部：二级菜单项列表
 *
 * 性能要点：
 * - 内部 usePathname() 订阅路由变化：避免依赖父级注入的 pathname 引用，保持 panel
 *   独立于 rail / shell 的其他 re-render（否则 rail 任何重渲染都会顺带拉上 panel）。
 * - React.memo + 默认浅比较：仅当 group / pinnedGroupId / 回调变化时才提交。
 *   shell 端必须传稳定引用（useCallback）才能生效。
 */
export const SidebarPanel = React.memo(function SidebarPanel({
  group,
  pinnedGroupId,
  onClose,
  onPinToggle,
  onNavigate,
}: SidebarPanelProps) {
  const pathname = usePathname()

  const isPinned = pinnedGroupId === group.id

  // 该分组下的二级菜单（已包含子项级角色过滤）
  const groupItems = group.items

  return (
    <div
      id='sidebar-panel'
      role='region'
      aria-label={`${group.label} 子菜单`}
      className='sidebar-panel-shell relative z-20 flex h-screen w-[240px] shrink-0 flex-col border-r border-[hsl(var(--sidebar-border))] bg-[hsl(var(--sidebar-background))]'
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className='flex h-[56px] shrink-0 items-center justify-between border-b border-[hsl(var(--sidebar-border))]/60 px-4'>
        <div className='flex min-w-0 items-center gap-2'>
          <group.icon className='h-4 w-4 shrink-0 text-sidebar-foreground/70' />
          <span className='truncate text-[0.95rem] font-semibold text-sidebar-foreground'>
            {group.label}
          </span>
        </div>
        <div className='flex items-center gap-1'>
          <button
            type='button'
            onClick={onPinToggle}
            aria-label={isPinned ? '取消固定面板' : '固定面板'}
            title={isPinned ? '取消固定' : '固定面板'}
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-md transition-colors',
              isPinned
                ? 'bg-primary/15 text-primary'
                : 'text-sidebar-foreground/50 hover:bg-[hsl(var(--sidebar-foreground)/0.05)] hover:text-sidebar-foreground',
            )}
          >
            {isPinned ? <PinOff className='h-3.5 w-3.5' /> : <Pin className='h-3.5 w-3.5' />}
          </button>
          <button
            type='button'
            onClick={onClose}
            aria-label='关闭面板'
            title='关闭'
            className='flex h-7 w-7 items-center justify-center rounded-md text-sidebar-foreground/50 transition-colors hover:bg-[hsl(var(--sidebar-foreground)/0.05)] hover:text-sidebar-foreground'
          >
            <X className='h-3.5 w-3.5' />
          </button>
        </div>
      </div>

      {/* Scrollable body */}
      <div className='flex-1 overflow-y-auto px-3 py-3'>
        {/* Sub items (secondary menu) */}
        <div className='mb-1'>
          <div className='mb-2 flex items-center justify-between px-1'>
            <span className='text-[0.7rem] font-semibold uppercase tracking-wider text-sidebar-foreground/40'>
              {group.label}
            </span>
          </div>
          {groupItems.length === 0 ? (
            <div className='rounded-[0.6rem] border border-dashed border-[hsl(var(--sidebar-foreground)/0.12)] px-3 py-4 text-center'>
              <p className='text-[0.78rem] text-sidebar-foreground/45'>
                暂无可访问的子项
              </p>
            </div>
          ) : (
            <nav className='flex flex-col gap-0.5' aria-label={`${group.label} 子菜单`}>
              {groupItems.map((item) => {
                const isActive = isLinkActive(pathname, item)
                const ItemIcon = item.icon ?? group.icon
                return (
                  <RouteLoadingLink
                    key={item.url}
                    href={item.url}
                    onClick={onNavigate}
                    data-active={isActive}
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(
                      'group/link flex h-10 items-center gap-2.5 rounded-[0.6rem] px-3 text-[0.88rem] font-medium transition-colors',
                      isActive
                        ? 'bg-[hsl(var(--sidebar-foreground)/0.08)] text-sidebar-foreground'
                        : 'text-sidebar-foreground/72 hover:bg-[hsl(var(--sidebar-foreground)/0.04)] hover:text-sidebar-foreground',
                    )}
                  >
                    <ItemIcon
                      className={cn(
                        'h-4 w-4 shrink-0 transition-colors',
                        'text-sidebar-foreground/55',
                      )}
                    />
                    <span className='min-w-0 flex-1 truncate'>{item.title}</span>
                    {isActive && <ChevronRight className='h-3.5 w-3.5 text-sidebar-foreground/40' />}
                  </RouteLoadingLink>
                )
              })}
            </nav>
          )}
        </div>
      </div>
    </div>
  )
})