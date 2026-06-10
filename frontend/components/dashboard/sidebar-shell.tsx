'use client'

import * as React from 'react'
import { usePathname } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { PanelLeft } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
 Sheet,
 SheetContent,
 SheetHeader,
 SheetTitle,
 SheetTrigger,
} from '@/components/ui/sheet'
import { RouteLoadingLink } from '@/components/dashboard/route-loading-link'
import { SidebarIconRail } from '@/components/dashboard/sidebar-icon-rail'
import { SidebarPanel } from '@/components/dashboard/sidebar-panel'
import { SidebarUserPanel } from '@/components/dashboard/sidebar-user-panel'
import { useSidebarPanel } from '@/components/dashboard/use-sidebar-panel'
import {
 SIDEBAR_TOP_GROUPS,
 findGroupByPathname,
 getVisibleGroups,
 type RoleType,
 type SidebarTopGroup,
} from '@/lib/sidebar-config'

interface SidebarShellProps {
 children?: React.ReactNode
}

/**
 * Sidebar两层结构整合组件。
 *
 *桌面端（>=md）：
 * - 外层固定窄栏68px（永远可见）
 * - 内层 panel240px（hover/click触发，push挤压内容区）
 *
 *移动端（<md）：
 * - Sheet抽屉，从左侧滑入
 */
export function SidebarShell({ children: _children }: SidebarShellProps = {}) {
 const pathname = usePathname()
 const { data: session } = useSession()
 const user = session?.user
 const roleType = user?.roleType as RoleType | undefined

 const visibleGroups = React.useMemo(
 () => getVisibleGroups(SIDEBAR_TOP_GROUPS, roleType),
 [roleType],
 )
 const findGroup = React.useCallback(
 (p: string) => findGroupByPathname(visibleGroups, p),
 [visibleGroups],
 )
 const panelState = useSidebarPanel(pathname, findGroup)
 const { activeGroupId, pinnedGroupId } = panelState

 const displayUser = React.useMemo(
 () => ({
 name: user?.name || 'User',
 email: user?.email || 'unknown',
 avatar: user?.image || '/avatars/default.svg',
 roleType,
 }),
 [user, roleType],
 )

 const onLogout = React.useCallback(() => {
 // signOut is imported lazily to avoid SSR issues; the actual call comes from layout.
 // SidebarShell doesn't own logout — it's wired via a callback in layout-level usage.
 // For simplicity we emit a custom event the layout listens to.
 window.dispatchEvent(new CustomEvent('believeboy:logout'))
 }, [])

 const activeGroup = activeGroupId
 ? visibleGroups.find((g) => g.id === activeGroupId) ?? null
 : null

 // Mobile sheet open state
 const [mobileOpen, setMobileOpen] = React.useState(false)

 return (
 <>
 {/* Desktop sidebar (>=md)
  *
  * 桌面端结构：外层 wrapper 是 relative 容器，rail 永远占 68px，
  * panel 改为 absolute 浮在 rail 右侧 0.5rem 处（不挤占主内容区宽度）。
  * 主内容区始终拿到完整可用宽度，仅在 panel 打开时被覆盖。
  */}
 <div
 className='relative hidden md:flex'
 onMouseLeave={() => { panelState.hoverLeave() }}
 >
 <SidebarIconRail
 groups={visibleGroups}
 activeGroupId={activeGroupId}
 pinnedGroupId={pinnedGroupId}
 onHoverEnter={panelState.hoverEnter}
 user={displayUser}
 />
 <div
 className={`sidebar-panel-shell pointer-events-none absolute left-[68px] top-0 z-40 flex h-screen w-[240px] flex-col overflow-hidden rounded-r-xl border border-[hsl(var(--sidebar-border))] bg-[hsl(var(--sidebar-background))] shadow-[0_24px_60px_-24px_rgba(15,23,42,0.28)] ring-1 ring-black/[0.04] transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.22,1.18,0.36,1)] ${
 activeGroupId
 ? 'translate-x-2 opacity-100'
 : '-translate-x-3 opacity-0'
 }`}
 onMouseEnter={() => {
 if (!activeGroupId) return
 // Re-enter hover state for the active group when mouse comes back into panel area
 panelState.hoverEnter(activeGroupId)
 }}
 >
 <div
 className={`flex h-full w-full flex-col ${
 activeGroupId ? 'pointer-events-auto' : 'pointer-events-none'
 }`}
 >
 {activeGroupId === 'user' ? (
 <SidebarUserPanel
 user={displayUser}
 pinned={pinnedGroupId === 'user'}
 onClose={panelState.closePanel}
 onPinToggle={() => panelState.clickToggle('user')}
 onLogout={onLogout}
 />
 ) : activeGroup ? (
 <SidebarPanel
 group={activeGroup}
 pinnedGroupId={pinnedGroupId}
 onClose={panelState.closePanel}
 onPinToggle={() => panelState.clickToggle(activeGroup.id)}
 onNavigate={() => {
 // Don't auto-close on navigate — let pinned state govern visibility
 }}
 />
 ) : null}
 </div>
 </div>
 </div>

 {/* Mobile trigger + sheet (<md) */}
 <div className='md:hidden'>
 <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
 <SheetTrigger asChild>
 <Button
 variant='outline'
 size='icon'
 className='fixed left-3 top-3 z-50 h-10 w-10 rounded-xl border-border/65 bg-[hsl(var(--surface-overlay)/0.85)] shadow-md backdrop-blur'
 aria-label='打开导航菜单'
 >
 <PanelLeft className='h-4 w-4' />
 </Button>
 </SheetTrigger>
 <SheetContent side='left' className='w-[300px] p-0'>
 <SheetHeader className='border-b border-border/60 px-4 py-3'>
 <SheetTitle>导航菜单</SheetTitle>
 </SheetHeader>
 <div className='flex flex-col gap-3 overflow-y-auto px-3 py-3'>
 {visibleGroups.map((group) => (
 <MobileGroupSection
 key={group.id}
 group={group}
 pathname={pathname}
 onNavigate={() => setMobileOpen(false)}
 />
 ))}
 </div>
 </SheetContent>
 </Sheet>
 </div>
 </>
 )
}

/**
 *移动端 Sheet 中的每个分组：直接展开为折叠列表。
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
 const Icon = group.icon

 return (
 <div className='rounded-[0.7rem] border border-border/60 bg-[hsl(var(--surface-overlay))]/40'>
 <button
 type='button'
 onClick={() => setOpen((v) => !v)}
 className='flex w-full items-center gap-2 px-3 py-2.5 text-left'
 >
 <span
 className={`flex h-7 w-7 items-center justify-center rounded-md border border-[hsl(var(--sidebar-foreground)/0.08)] ${group.accent}`}
 >
 <Icon className='h-4 w-4' />
 </span>
 <span className='flex-1 text-[0.92rem] font-semibold'>{group.label}</span>
 <span className='text-[0.7rem] text-muted-foreground'>
 {group.items.length}
 </span>
 </button>
 {open && group.items.length >0 && (
 <nav className='flex flex-col gap-0.5 border-t border-border/60 px-2 py-2'>
 {group.items.map((item) => {
 const isActive = (() => {
 if (item.url === '/dashboard') return pathname === item.url
 if (pathname === item.url) return true
 return item.matchPrefixes?.some((p) => pathname.startsWith(p)) ?? false
 })()
 const ItemIcon = item.icon ?? group.icon
 return (
 <RouteLoadingLink
 key={item.url}
 href={item.url}
 onClick={onNavigate}
 className={`flex h-9 items-center gap-2 rounded-md px-2.5 text-[0.86rem] transition-colors ${
 isActive
 ? 'bg-primary/10 font-semibold text-primary'
 : 'text-foreground/80 hover:bg-muted'
 }`}
 >
 <ItemIcon className='h-4 w-4 shrink-0' />
 <span className='min-w-0 flex-1 truncate'>{item.title}</span>
 </RouteLoadingLink>
 )
 })}
 </nav>
 )}
 </div>
 )
}
