'use client'

import * as React from 'react'
import Link from 'next/link'
import { useTheme } from 'next-themes'
import {
 Check,
 ChevronsUpDown,
 Factory,
 KeyRound,
 LogOut,
 Monitor,
 Moon,
 Shield,
 Store,
 SunMedium,
} from 'lucide-react'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import {
 DropdownMenu,
 DropdownMenuContent,
 DropdownMenuItem,
 DropdownMenuLabel,
 DropdownMenuSeparator,
 DropdownMenuSub,
 DropdownMenuSubContent,
 DropdownMenuSubTrigger,
 DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { RouteLoadingLink } from '@/components/dashboard/route-loading-link'
import type { SidebarTopGroup, RoleType } from '@/lib/sidebar-config'
import { isLinkActive } from '@/lib/sidebar-config'
import { cn } from '@/lib/utils'

interface SidebarIconRailProps {
 groups: SidebarTopGroup[]
 activeGroupId: string | null
 pinnedGroupId: string | null
 onHoverEnter: (id: string) => void
 onHoverLeave: () => void
 onClickToggle: (id: string) => void
 user: {
 name: string
 email: string
 avatar?: string
 roleType?: RoleType
 }
 onLogout: () => void
}

const ROLE_LABELS: Record<string, string> = {
 admin: '管理员',
 operator: '运营',
 businessdev: '招商',
 factory: '工厂',
}

function MiniUserMenu({
 user,
 onLogout,
}: {
 user: SidebarIconRailProps['user']
 onLogout: () => void
}) {
 const { theme, setTheme } = useTheme()
 const [mounted, setMounted] = React.useState(false)
 React.useEffect(() => setMounted(true), [])
 const currentTheme = mounted ? theme : 'system'
 const fallback = user.name?.[0]?.toUpperCase() || 'U'
 const roleLabel = user.roleType ? ROLE_LABELS[user.roleType] : null

 return (
 <DropdownMenu>
 <DropdownMenuTrigger asChild>
 <button
 type='button'
 title={`${user.name} ·账户菜单`}
 aria-label={`${user.name}，打开账户菜单`}
 className='flex h-10 w-10 items-center justify-center rounded-full border border-[hsl(var(--sidebar-foreground)/0.08)] bg-[hsl(var(--sidebar-foreground)/0.03)] text-sidebar-foreground transition-all hover:bg-[hsl(var(--sidebar-foreground)/0.08)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40'
 >
 <Avatar className='h-9 w-9'>
 <AvatarImage src={user.avatar} alt={user.name} />
 <AvatarFallback className='text-xs font-semibold'>
 {fallback}
 </AvatarFallback>
 </Avatar>
 </button>
 </DropdownMenuTrigger>
 <DropdownMenuContent side='right' align='end' sideOffset={8} className='w-64'>
 <DropdownMenuLabel className='p-0 font-normal'>
 <div className='flex items-center gap-2 px-1 py-1.5 text-left'>
 <Avatar className='h-8 w-8 rounded-md'>
 <AvatarImage src={user.avatar} alt={user.name} />
 <AvatarFallback className='rounded-md text-xs'>{fallback}</AvatarFallback>
 </Avatar>
 <div className='grid flex-1 text-left text-sm leading-tight'>
 <span className='truncate font-semibold'>{user.name}</span>
 <span className='truncate text-xs text-muted-foreground'>
 {user.email}
 {roleLabel ? ` · ${roleLabel}` : ''}
 </span>
 </div>
 </div>
 </DropdownMenuLabel>
 <DropdownMenuSeparator />
 <DropdownMenuSub>
 <DropdownMenuSubTrigger>
 <SunMedium className='h-4 w-4' />
 <span>外观</span>
 </DropdownMenuSubTrigger>
 <DropdownMenuSubContent>
 <DropdownMenuItem onClick={() => setTheme('light')}>
 <SunMedium className='h-4 w-4' />
 <span>浅色</span>
 {currentTheme === 'light' ? <Check className='ml-auto h-4 w-4' /> : null}
 </DropdownMenuItem>
 <DropdownMenuItem onClick={() => setTheme('dark')}>
 <Moon className='h-4 w-4' />
 <span>深色</span>
 {currentTheme === 'dark' ? <Check className='ml-auto h-4 w-4' /> : null}
 </DropdownMenuItem>
 <DropdownMenuItem onClick={() => setTheme('system')}>
 <Monitor className='h-4 w-4' />
 <span>跟随系统</span>
 {currentTheme === 'system' ? <Check className='ml-auto h-4 w-4' /> : null}
 </DropdownMenuItem>
 </DropdownMenuSubContent>
 </DropdownMenuSub>
 <DropdownMenuSeparator />
 <DropdownMenuItem asChild>
 <RouteLoadingLink href='/dashboard/change-password'>
 <KeyRound className='h-4 w-4' />
 修改密码
 </RouteLoadingLink>
 </DropdownMenuItem>
 <DropdownMenuSeparator />
 <DropdownMenuItem onClick={onLogout}>
 <LogOut className='h-4 w-4' />
退出登录
 </DropdownMenuItem>
 </DropdownMenuContent>
 </DropdownMenu>
 )
}

/**
 * 外层68px固定窄栏：Logo +7 个 group icon +底部 user menu。
 */
export function SidebarIconRail({
 groups,
 activeGroupId,
 pinnedGroupId,
 onHoverEnter,
 onHoverLeave,
 onClickToggle,
 user,
 onLogout,
}: SidebarIconRailProps) {
 return (
 <div
 className='sidebar-rail relative z-30 flex h-screen w-[68px] shrink-0 flex-col border-r border-[hsl(var(--sidebar-border))] bg-[hsl(var(--sidebar-background))]'
 onMouseLeave={onHoverLeave}
 >
 {/* Logo */}
 <div className='flex h-[56px] shrink-0 items-center justify-center border-b border-[hsl(var(--sidebar-border))]/60'>
 <Link
 href='/dashboard'
 className='group flex h-9 w-9 items-center justify-center rounded-[0.6rem] bg-gradient-to-br from-blue-500 to-indigo-600 text-sm font-bold text-white shadow-sm transition-transform hover:scale-105'
 title='BelieveBoy运营控制台'
 aria-label='BelieveBoy运营控制台'
 >
 BB
 </Link>
 </div>

 {/* Group icons */}
 <nav
 className='flex flex-1 flex-col items-center gap-1 overflow-y-auto px-3 py-3'
 aria-label='主导航'
 >
 {groups.map((group) => {
 const Icon = group.icon
 const isActive = activeGroupId === group.id
 const isPinned = pinnedGroupId === group.id
 const pathname =
 typeof window !== 'undefined' ? window.location.pathname : ''
 const hasActiveItem = group.items.some((it) =>
 isLinkActive(pathname, it),
 )

 return (
 <button
 key={group.id}
 type='button'
 data-active={isActive}
 data-pinned={isPinned}
 data-has-active={hasActiveItem}
 onMouseEnter={() => onHoverEnter(group.id)}
 onClick={() => onClickToggle(group.id)}
 aria-label={group.label}
 aria-expanded={isActive}
 aria-controls='sidebar-panel'
 title={group.label}
 className={cn(
 'group/icon flex h-11 w-11 shrink-0 items-center justify-center rounded-[0.85rem] border border-[hsl(var(--sidebar-foreground)/0.08)] shadow-[inset_0_1px_0_hsl(var(--sidebar-foreground)/0.06)] transition-all duration-200 ease-out',
 'hover:scale-[1.04] hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
 hasActiveItem ? group.activeAccent : group.accent,
 isActive && 'ring-2 ring-primary/30',
 )}
 >
 <Icon
 className={cn(
 'h-5 w-5 transition-all',
 !hasActiveItem && 'grayscale-[40%] group-hover/icon:grayscale-0',
 )}
 />
 </button>
 )
 })}
 </nav>

 {/* User menu (compact) */}
 <div className='shrink-0 border-t border-[hsl(var(--sidebar-border))]/60 px-2 pb-3 pt-2'>
 <MiniUserMenu user={user} onLogout={onLogout} />
 </div>
 </div>
 )
}

