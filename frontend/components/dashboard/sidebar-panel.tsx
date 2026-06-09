'use client'

import * as React from 'react'
import { usePathname } from 'next/navigation'
import {
 ChevronRight,
 Clock,
 Pin,
 PinOff,
 Plus,
 Settings,
 X,
} from 'lucide-react'

import { RouteLoadingLink } from '@/components/dashboard/route-loading-link'
import {
 ALL_ITEMS,
 PinSettingsPopover,
 getVisibleItems,
 useSidebarPinnedItems,
 useVisiblePinnedUrls,
} from '@/components/dashboard/sidebar-pin-settings'
import { useRecentPages, shortPath } from '@/lib/recent-pages'
import { isLinkActive, type RoleType, type SidebarTopGroup } from '@/lib/sidebar-config'
import { cn } from '@/lib/utils'

interface SidebarPanelProps {
 group: SidebarTopGroup
 pinnedGroupId: string | null
 roleType?: RoleType
 onClose: () => void
 onPinToggle: () => void
 onNavigate: () => void
}

/**
 * 内层240px弹出面板：
 * -顶部：组标题 +关闭按钮 + pin按钮
 * -顶部区：Pinned快捷入口 chip
 * - 中部：二级菜单项列表
 * -底部：最近访问
 */
export function SidebarPanel({
 group,
 pinnedGroupId,
 roleType,
 onClose,
 onPinToggle,
 onNavigate,
}: SidebarPanelProps) {
 const pathname = usePathname()
 const { pinnedUrls, toggle: togglePin } = useSidebarPinnedItems()
 const { recentPages } = useRecentPages()

 const isPinned = pinnedGroupId === group.id
 const visiblePinnedUrls = useVisiblePinnedUrls(pinnedUrls, roleType)
 const visibleItems = getVisibleItems(roleType)
 const visibleUrlsSet = new Set(visiblePinnedUrls)

 // 仅显示当前分组的 pinned chip（按 group关联性过滤）
 const groupItemUrls = new Set(group.items.map((it) => it.url))
 const groupPinnedItems = ALL_ITEMS.filter(
 (it) => groupItemUrls.has(it.url) && visibleUrlsSet.has(it.url),
 )
 const otherPinnedItems = ALL_ITEMS.filter(
 (it) => !groupItemUrls.has(it.url) && visibleUrlsSet.has(it.url),
 )

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
 {/* Pinned (current group) */}
 {groupPinnedItems.length >0 && (
 <div className='mb-4'>
 <div className='mb-2 flex items-center justify-between px-1'>
 <span className='text-[0.7rem] font-semibold uppercase tracking-wider text-sidebar-foreground/40'>
本组快捷入口
 </span>
 </div>
 <div className='flex flex-wrap gap-1.5'>
 {groupPinnedItems.map((item) => {
 const Icon = item.icon
 return (
 <RouteLoadingLink
 key={item.url}
 href={item.url}
 onClick={onNavigate}
 className='group/chip flex h-9 items-center gap-1.5 rounded-[0.6rem] border border-[hsl(var(--sidebar-foreground)/0.08)] bg-[hsl(var(--sidebar-foreground)/0.03)] px-2.5 text-[0.8rem] font-medium text-sidebar-foreground/80 transition-colors hover:border-[hsl(var(--sidebar-foreground)/0.16)] hover:bg-[hsl(var(--sidebar-foreground)/0.06)] hover:text-sidebar-foreground'
 title={item.title}
 >
 {React.isValidElement(Icon) ? Icon : null}
 <span className='truncate'>{item.title}</span>
 </RouteLoadingLink>
 )
 })}
 </div>
 </div>
 )}

 {/* Pinned (other groups, collapsed) */}
 {otherPinnedItems.length >0 && (
 <div className='mb-4'>
 <div className='mb-2 flex items-center justify-between px-1'>
 <span className='text-[0.7rem] font-semibold uppercase tracking-wider text-sidebar-foreground/40'>
其它快捷入口
 </span>
 <PinSettingsPopover
 pinnedUrls={pinnedUrls}
 onToggle={togglePin}
 roleType={roleType}
 trigger={
 <button
 type='button'
 aria-label='管理快捷入口'
 className='flex h-6 w-6 items-center justify-center rounded text-sidebar-foreground/40 hover:bg-[hsl(var(--sidebar-foreground)/0.05)] hover:text-sidebar-foreground'
 >
 <Settings className='h-3 w-3' />
 </button>
 }
 />
 </div>
 <div className='flex flex-wrap gap-1.5'>
 {otherPinnedItems.slice(0,6).map((item) => {
 const Icon = item.icon
 return (
 <RouteLoadingLink
 key={item.url}
 href={item.url}
 onClick={onNavigate}
 className='group/chip flex h-9 items-center gap-1.5 rounded-[0.6rem] border border-[hsl(var(--sidebar-foreground)/0.08)] bg-[hsl(var(--sidebar-foreground)/0.03)] px-2.5 text-[0.8rem] font-medium text-sidebar-foreground/70 transition-colors hover:border-[hsl(var(--sidebar-foreground)/0.16)] hover:bg-[hsl(var(--sidebar-foreground)/0.06)] hover:text-sidebar-foreground'
 title={item.title}
 >
 {React.isValidElement(Icon) ? Icon : null}
 <span className='truncate'>{item.title}</span>
 </RouteLoadingLink>
 )
 })}
 {otherPinnedItems.length >6 && (
 <span className='flex h-9 items-center px-2 text-[0.7rem] text-sidebar-foreground/40'>
 +{otherPinnedItems.length -6}
 </span>
 )}
 </div>
 </div>
 )}

 {/* Empty pinned state */}
 {visiblePinnedUrls.length ===0 && (
 <div className='mb-4 rounded-[0.6rem] border border-dashed border-[hsl(var(--sidebar-foreground)/0.12)] px-3 py-3 text-center'>
 <p className='text-[0.78rem] text-sidebar-foreground/45'>
暂无快捷入口，可点击右上角设置添加
 </p>
 </div>
 )}

 {/* Sub items (secondary menu) */}
 <div className='mb-1'>
 <div className='mb-2 flex items-center justify-between px-1'>
 <span className='text-[0.7rem] font-semibold uppercase tracking-wider text-sidebar-foreground/40'>
 {group.label}
 </span>
 {visiblePinnedUrls.length < visibleItems.length && (
 <PinSettingsPopover
 pinnedUrls={pinnedUrls}
 onToggle={togglePin}
 roleType={roleType}
 trigger={
 <button
 type='button'
 aria-label='添加快捷入口'
 className='flex h-6 items-center gap-1 rounded px-1.5 text-[0.7rem] text-sidebar-foreground/40 hover:bg-[hsl(var(--sidebar-foreground)/0.05)] hover:text-sidebar-foreground'
 >
 <Plus className='h-3 w-3' />
 <span>添加</span>
 </button>
 }
 />
 )}
 </div>
 {groupItems.length ===0 ? (
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
 isActive ? 'text-primary' : 'text-sidebar-foreground/50 group-hover/link:text-sidebar-foreground/70',
 )}
 />
 <span className='min-w-0 flex-1 truncate'>{item.title}</span>
 {isActive && <ChevronRight className='h-3.5 w-3.5 text-primary' />}
 </RouteLoadingLink>
 )
 })}
 </nav>
 )}
 </div>
 </div>

 {/* Footer: Recent pages */}
 {recentPages.length >0 && (
 <div className='shrink-0 border-t border-[hsl(var(--sidebar-border))]/60 px-3 py-3'>
 <div className='mb-2 flex items-center gap-1.5 px-1'>
 <Clock className='h-3 w-3 text-sidebar-foreground/40' />
 <span className='text-[0.7rem] font-semibold uppercase tracking-wider text-sidebar-foreground/40'>
最近访问
 </span>
 </div>
 <nav className='flex flex-col gap-0.5' aria-label='最近访问'>
 {recentPages.slice(0,3).map((page) => {
 const isActive = pathname === page.path
 return (
 <RouteLoadingLink
 key={page.path}
 href={page.path}
 onClick={onNavigate}
 data-active={isActive}
 className={cn(
 'flex h-8 items-center gap-2 rounded-[0.5rem] px-2.5 text-[0.78rem] transition-colors',
 isActive
 ? 'bg-[hsl(var(--sidebar-foreground)/0.06)] text-sidebar-foreground'
 : 'text-sidebar-foreground/60 hover:bg-[hsl(var(--sidebar-foreground)/0.04)] hover:text-sidebar-foreground',
 )}
 >
 <span className='min-w-0 flex-1 truncate'>{page.title}</span>
 <span className='shrink-0 text-[0.66rem] text-sidebar-foreground/30'>
 {shortPath(page.path)}
 </span>
 </RouteLoadingLink>
 )
 })}
 </nav>
 </div>
 )}
 </div>
 )
}
