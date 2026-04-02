'use client'

import { ChevronsUpDown, KeyRound, LogOut } from 'lucide-react'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { RouteLoadingLink } from '@/components/dashboard/route-loading-link'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar'

interface User {
  name: string
  email: string
  avatar?: string
  isAdmin?: boolean
}

interface NavUserProps {
  user: User
  onLogout: () => void
}

export function NavUser({ user, onLogout }: NavUserProps) {
  const { isMobile } = useSidebar()
  const fallback = user.name?.[0]?.toUpperCase() || 'U'

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="rounded-[0.95rem] border border-[hsl(var(--sidebar-foreground)/0.08)] bg-[hsl(var(--sidebar-background))] text-sidebar-foreground shadow-none hover:bg-[hsl(var(--sidebar-foreground)/0.02)] data-[state=open]:bg-[hsl(var(--sidebar-foreground)/0.04)]"
            >
              <Avatar className="h-8 w-8 rounded-[0.75rem]">
                <AvatarImage src={user.avatar} alt={user.name} />
                <AvatarFallback className="rounded-[0.75rem]">{fallback}</AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold text-sidebar-foreground">{user.name}</span>
                <span className="truncate text-[0.78rem] text-sidebar-foreground/46">{user.email}</span>
              </div>
              <ChevronsUpDown className="ml-auto size-4 text-sidebar-foreground/40" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg"
            side={isMobile ? 'bottom' : 'right'}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-left text-base">
                <Avatar className="h-8 w-8 rounded-md">
                  <AvatarImage src={user.avatar} alt={user.name} />
                  <AvatarFallback className="rounded-md">{fallback}</AvatarFallback>
                </Avatar>
                <div className="grid flex-1 text-left text-base leading-tight">
                  <span className="truncate font-semibold">{user.name}</span>
                  <span className="truncate text-sm">
                    {user.email}
                    {user.isAdmin ? ' · 管理员' : ' · 普通用户'}
                  </span>
                </div>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem asChild>
                <RouteLoadingLink href="/dashboard/change-password">
                  <KeyRound />
                  修改密码
                </RouteLoadingLink>
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onLogout}>
              <LogOut />
              退出登录
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
