'use client'

import { ChevronRight } from 'lucide-react'
import { usePathname } from 'next/navigation'

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { RouteLoadingLink } from '@/components/dashboard/route-loading-link'

interface NavItem {
  title: string
  url: string
  icon?: React.ReactNode
  isActive?: boolean
  items?: {
    title: string
    url: string
  }[]
}

interface NavMainProps {
  items: NavItem[]
}

export function NavMain({ items }: NavMainProps) {
  const pathname = usePathname()
  const { setOpen, state } = useSidebar()

  const handleTriggerClick = () => {
    if (state === 'collapsed') {
      setOpen(true)
    }
  }

  return (
    <SidebarGroup>
      <SidebarGroupLabel>工作面板</SidebarGroupLabel>
      <SidebarMenu>
        {items.map((item) => (
          (() => {
            const hasActiveChild = item.items?.some((subItem) => pathname === subItem.url) ?? false

            return (
          <Collapsible
            key={item.title}
            asChild
            defaultOpen={item.isActive || hasActiveChild}
            className="group/collapsible"
          >
            <SidebarMenuItem>
              {item.items ? (
                <>
                  <CollapsibleTrigger asChild>
                    <SidebarMenuButton 
                      tooltip={item.title}
                      isActive={hasActiveChild}
                      onClick={handleTriggerClick}
                    >
                      {item.icon}
                      <span>{item.title}</span>
                      <ChevronRight className="ml-auto transition-transform duration-300 ease-out group-data-[state=open]/collapsible:rotate-90" />
                    </SidebarMenuButton>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down data-[state=closed]:opacity-0 data-[state=open]:opacity-100">
                    <SidebarMenuSub className="transition-[transform,opacity] duration-300 ease-out group-data-[state=closed]/collapsible:-translate-y-1 group-data-[state=closed]/collapsible:opacity-0 group-data-[state=open]/collapsible:translate-y-0 group-data-[state=open]/collapsible:opacity-100">
                      {item.items?.map((subItem) => (
                        <SidebarMenuSubItem key={subItem.title}>
                          <SidebarMenuSubButton
                            asChild
                            isActive={pathname === subItem.url}
                          >
                            <RouteLoadingLink href={subItem.url}>
                              <span>{subItem.title}</span>
                            </RouteLoadingLink>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      ))}
                    </SidebarMenuSub>
                  </CollapsibleContent>
                </>
              ) : (
                <SidebarMenuButton
                  asChild
                  tooltip={item.title}
                  isActive={pathname === item.url}
                >
                  <RouteLoadingLink href={item.url}>
                    {item.icon}
                    <span>{item.title}</span>
                  </RouteLoadingLink>
                </SidebarMenuButton>
              )}
            </SidebarMenuItem>
          </Collapsible>
            )
          })()
        ))}
      </SidebarMenu>
    </SidebarGroup>
  )
}
