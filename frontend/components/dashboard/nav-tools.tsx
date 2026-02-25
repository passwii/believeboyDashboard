'use client'

import { ChevronRight } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'

interface ToolGroup {
  title: string
  icon?: React.ReactNode
  items: {
    title: string
    url: string
  }[]
}

interface NavToolsProps {
  tools: ToolGroup[]
}

export function NavTools({ tools }: NavToolsProps) {
  const pathname = usePathname()

  return (
    <SidebarGroup className="group-data-[collapsible=offcanvas]:hidden">
      <SidebarGroupLabel>运营工具</SidebarGroupLabel>
      <SidebarMenu>
        {tools.map((tool) => (
          <Collapsible
            key={tool.title}
            asChild
            defaultOpen={tool.items.some((subItem) => subItem.url === pathname)}
            className="group/collapsible"
          >
            <SidebarMenuItem>
              <CollapsibleTrigger asChild>
                <SidebarMenuButton tooltip={tool.title}>
                  {tool.icon}
                  <span>{tool.title}</span>
                  <ChevronRight className="ml-auto transition-transform duration-300 ease-out group-data-[state=open]/collapsible:rotate-90" />
                </SidebarMenuButton>
              </CollapsibleTrigger>
              <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down data-[state=closed]:opacity-0 data-[state=open]:opacity-100">
                <SidebarMenuSub className="transition-[transform,opacity] duration-300 ease-out group-data-[state=closed]/collapsible:-translate-y-1 group-data-[state=closed]/collapsible:opacity-0 group-data-[state=open]/collapsible:translate-y-0 group-data-[state=open]/collapsible:opacity-100">
                  {tool.items.map((subItem) => (
                    <SidebarMenuSubItem key={subItem.title}>
                      <SidebarMenuSubButton
                        asChild
                        isActive={pathname === subItem.url}
                      >
                        <Link href={subItem.url}>
                          <span>{subItem.title}</span>
                        </Link>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  ))}
                </SidebarMenuSub>
              </CollapsibleContent>
            </SidebarMenuItem>
          </Collapsible>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  )
}
