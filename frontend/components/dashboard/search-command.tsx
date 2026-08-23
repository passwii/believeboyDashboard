'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { ChevronRight } from 'lucide-react'

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'
import {
  SIDEBAR_TOP_GROUPS,
  filterByRole,
  type RoleType,
  type SidebarSubItem,
} from '@/lib/sidebar-config'

type SearchItem = {
  title: string
  url: string
  icon: React.ReactNode
  category: string
}

function buildSearchItems(roleType?: RoleType): { items: SearchItem[]; categories: string[] } {
  const items: SearchItem[] = []
  const categorySet = new Set<string>()
  SIDEBAR_TOP_GROUPS.forEach((group) => {
    const groupVisible = filterByRole(group.items, roleType)
    if (groupVisible.length === 0) return
    groupVisible.forEach((item) => {
      items.push({
        title: item.title,
        url: item.url,
        icon: item.icon ? <item.icon className="h-4 w-4" /> : <group.icon className="h-4 w-4" />,
        category: group.label,
      })
      categorySet.add(group.label)
    })
  })
  return { items, categories: Array.from(categorySet) }
}

export const OPEN_SEARCH_EVENT = 'believeboy:open-search'

export function SearchCommand() {
  const [open, setOpen] = React.useState(false)
  const router = useRouter()

  React.useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((open) => !open)
      }
    }

    document.addEventListener('keydown', down)
    return () => document.removeEventListener('keydown', down)
  }, [])

  // Terminal SubNav / Header 的"搜索"按钮经全局事件打开同一命令面板（BLF-809）
  React.useEffect(() => {
    const openHandler = () => setOpen(true)
    window.addEventListener(OPEN_SEARCH_EVENT, openHandler)
    return () => window.removeEventListener(OPEN_SEARCH_EVENT, openHandler)
  }, [])

  const { items: navItems, categories: CATEGORIES } = React.useMemo(() => buildSearchItems(), [])

  const grouped = (CATEGORIES as readonly string[]).reduce<Record<string, SearchItem[]>>(
    (acc, cat) => {
      const items = navItems.filter((item) => item.category === cat)
      if (items.length > 0) acc[cat] = items
      return acc
    },
    {}
  )

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="搜索页面、工具与报表..." />
      <CommandList>
        <CommandEmpty>未找到相关结果</CommandEmpty>
        {Object.entries(grouped).map(([category, items]) => (
          <React.Fragment key={category}>
            <CommandGroup heading={category}>
              {items.map((item) => (
                <CommandItem
                  key={item.url}
                  value={item.title}
                  onSelect={() => {
                    router.push(item.url)
                    setOpen(false)
                  }}
                >
                  <span className="mr-2 text-muted-foreground">{item.icon}</span>
                  <span className="flex-1">{item.title}</span>
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60" />
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </React.Fragment>
        ))}
      </CommandList>
    </CommandDialog>
  )
}

/**
 *导出类型供外部使用。
 */
export type { RoleType, SidebarSubItem }
