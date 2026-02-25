'use client'

import { RouteLoadingLink } from '@/components/dashboard/route-loading-link'

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'

interface NavItem {
  title: string
  url: string
  icon: React.ReactNode
}

interface NavSecondaryProps {
  items: NavItem[]
}

export function NavSecondary({ items }: NavSecondaryProps) {
  return (
    <SidebarGroup className="mt-auto">
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.title}>
              <SidebarMenuButton asChild>
                <RouteLoadingLink href={item.url}>
                  {item.icon}
                  <span>{item.title}</span>
                </RouteLoadingLink>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
