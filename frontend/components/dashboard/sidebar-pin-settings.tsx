'use client'

import * as React from 'react'
import {
  Bot,
  Calculator,
  ChartColumnBig,
  Check,
  ChevronRight,
  Package,
  Settings,
  TrendingUp,
} from 'lucide-react'

import { RouteLoadingLink } from '@/components/dashboard/route-loading-link'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

const STORAGE_KEY = 'believeboy-sidebar-pinned-v1'
const MAX_PINNED = 3

type PinnedItem = {
  title: string
  url: string
  icon: React.ReactNode
}

const ALL_ITEMS: PinnedItem[] = [
  {
    title: '发货管理',
    url: '/dashboard/data-management/shipment-management',
    icon: <Package className='h-4 w-4' />,
  },
  {
    title: '销售数据',
    url: '/dashboard/data-analysis/daily-analysis',
    icon: <TrendingUp className='h-4 w-4' />,
  },
  {
    title: 'AI 聊天',
    url: '/dashboard/ai-panel/chat',
    icon: <Bot className='h-4 w-4' />,
  },
  {
    title: '销售日报',
    url: '/dashboard/data-reporting/daily-report',
    icon: <ChartColumnBig className='h-4 w-4' />,
  },
  {
    title: '财务月报',
    url: '/dashboard/data-reporting/monthly-report',
    icon: <Calculator className='h-4 w-4' />,
  },
  {
    title: '项目目标',
    url: '/dashboard/data-analysis/project-goals',
    icon: <TrendingUp className='h-4 w-4' />,
  },
  {
    title: '数字员工',
    url: '/dashboard/digital-employees',
    icon: <Bot className='h-4 w-4' />,
  },
]

const DEFAULT_PINNED_URLS = [
  '/dashboard/data-management/shipment-management',
  '/dashboard/data-analysis/daily-analysis',
  '/dashboard/ai-panel/chat',
]

function loadPinnedUrls(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as string[]
      if (Array.isArray(parsed) && parsed.every((u) => typeof u === 'string')) {
        return parsed
      }
    }
  } catch {
    // ignore
  }
  return DEFAULT_PINNED_URLS
}

function savePinnedUrls(urls: string[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(urls))
  } catch {
    // ignore
  }
}

export function useSidebarPinnedItems() {
  const [pinnedUrls, setPinnedUrls] = React.useState<string[]>(() => loadPinnedUrls())

  const toggle = React.useCallback((url: string) => {
    setPinnedUrls((prev) => {
      const next = prev.includes(url) ? prev.filter((u) => u !== url) : prev.length < MAX_PINNED ? [...prev, url] : prev
      savePinnedUrls(next)
      return next
    })
  }, [])

  return { pinnedUrls, toggle, maxPinned: MAX_PINNED }
}

function PinSettingsContent({
  pinnedUrls,
  onToggle,
}: {
  pinnedUrls: string[]
  onToggle: (url: string) => void
}) {
  const atMax = pinnedUrls.length >= MAX_PINNED

  return (
    <div className='flex flex-col gap-1'>
      <div className='mb-2 flex items-center justify-between'>
        <span className='text-[0.82rem] font-semibold text-foreground'>
          快捷入口设置
        </span>
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-[0.7rem] font-medium',
            atMax
              ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400'
              : 'bg-muted text-muted-foreground'
          )}
        >
          {pinnedUrls.length}/{MAX_PINNED}
        </span>
      </div>
      <div className='flex flex-col gap-0.5'>
        {ALL_ITEMS.map((item) => {
          const isPinned = pinnedUrls.includes(item.url)
          const disabled = !isPinned && atMax
          return (
            <button
              key={item.url}
              type='button'
              disabled={disabled}
              onClick={() => !disabled && onToggle(item.url)}
              className={cn(
                'flex items-center gap-2.5 rounded-md px-2 py-2 text-left text-[0.82rem] transition-colors',
                disabled
                  ? 'cursor-not-allowed opacity-40'
                  : 'hover:bg-accent cursor-pointer'
              )}
            >
              <span className='flex h-6 w-6 shrink-0 items-center justify-center rounded border border-border/60 bg-muted/60 text-muted-foreground'>
                {item.icon}
              </span>
              <span className='min-w-0 flex-1 truncate text-foreground'>{item.title}</span>
              <span
                className={cn(
                  'flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border',
                  isPinned
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-background'
                )}
              >
                {isPinned && <Check className='h-3 w-3' />}
              </span>
            </button>
          )
        })}
      </div>
      {atMax && (
        <p className='mt-1 text-center text-[0.72rem] text-muted-foreground'>
          最多 {MAX_PINNED} 个快捷入口，已达上限
        </p>
      )}
    </div>
  )
}

export function SidebarPinSettings({
  pinnedUrls,
  onToggle,
}: {
  pinnedUrls: string[]
  onToggle: (url: string) => void
}) {
  const [open, setOpen] = React.useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className='flex h-11 w-11 min-w-touch items-center justify-center rounded-[0.65rem] border border-[hsl(var(--sidebar-foreground)/0.08)] bg-[hsl(var(--sidebar-foreground)/0.03)] text-sidebar-foreground/50 shadow-none transition-all duration-200 hover:bg-[hsl(var(--sidebar-foreground)/0.08)] hover:text-sidebar-foreground group-data-[collapsible=icon]:hidden'
          title='设置快捷入口'
        >
          <Settings className='h-4 w-4' />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side='right'
        align='start'
        sideOffset={8}
        className='w-64 p-3'
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <PinSettingsContent pinnedUrls={pinnedUrls} onToggle={onToggle} />
      </PopoverContent>
    </Popover>
  )
}

export function SidebarPinnedItem({ url, title }: { url: string; title: string }) {
  return (
    <RouteLoadingLink
      href={url}
      className='flex h-11 w-11 min-w-touch items-center justify-center rounded-[0.65rem] border border-[hsl(var(--sidebar-foreground)/0.08)] bg-[hsl(var(--sidebar-foreground)/0.03)] text-sidebar-foreground/72 shadow-none transition-all duration-200 hover:bg-[hsl(var(--sidebar-foreground)/0.08)] hover:text-sidebar-foreground group-data-[collapsible=icon]:hidden'
      title={title}
    >
      {ALL_ITEMS.find((item) => item.url === url)?.icon ?? <ChevronRight className='h-4 w-4' />}
    </RouteLoadingLink>
  )
}
