'use client'

import { useState } from 'react'
import { RouteLoadingLink } from '@/components/dashboard/route-loading-link'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { useRecentPages, shortPath } from '@/lib/recent-pages'
import { cn } from '@/lib/utils'
import { Clock, Trash2 } from 'lucide-react'

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  const minutes = Math.floor(diff / 60_000)
  const hours = Math.floor(diff / 3_600_000)
  const days = Math.floor(diff / 86_400_000)

  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  if (hours < 24) return `${hours} 小时前`
  if (days === 1) return '昨天'
  if (days < 7) return `${days} 天前`
  return `${Math.floor(days / 7)} 周前`
}

interface RecentPageItemProps {
  path: string
  title: string
  visitedAt: number
  isActive: boolean
  index: number
}

function RecentPageItem({ path, title, visitedAt, isActive, index }: RecentPageItemProps) {
  return (
    <RouteLoadingLink href={path}>
      <div
        className={cn(
          'group flex min-w-0 cursor-pointer items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors',
          'hover:bg-[hsl(var(--surface-subtle))]',
          isActive
            ? 'bg-[hsl(var(--surface-subtle))] text-foreground'
            : 'text-muted-foreground'
        )}
        style={{ animationDelay: `${index * 30}ms` }}
      >
        <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-foreground/90">{title}</div>
          <div className="truncate text-xs text-muted-foreground/60">{shortPath(path)}</div>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground/50 tabular-nums">
          {formatRelativeTime(visitedAt)}
        </span>
      </div>
    </RouteLoadingLink>
  )
}

export function RecentPagesDropdown() {
  const { recentPages, clearHistory } = useRecentPages()
  const [open, setOpen] = useState(false)

  const handleClear = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    clearHistory()
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            'h-10 w-10 rounded-xl border border-transparent bg-transparent text-secondary transition-all',
            open
              ? 'bg-[hsl(var(--surface-subtle))] text-foreground'
              : 'hover:bg-[hsl(var(--surface-subtle))]'
          )}
          aria-label="最近浏览"
        >
          <Clock className="h-4 w-4" />
          <span className="sr-only">最近浏览</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={8}
        className="w-[22rem] p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 pt-4 pb-2">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-semibold">最近浏览</span>
            {recentPages.length > 0 && (
              <span className="rounded-full bg-[hsl(var(--surface-subtle))] px-2 py-0.5 text-xs text-muted-foreground">
                {recentPages.length}
              </span>
            )}
          </div>
          {recentPages.length > 0 && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-md text-muted-foreground hover:text-destructive"
              onClick={handleClear}
              aria-label="清除历史记录"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>

        <Separator className="mb-1" />

        {recentPages.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
            <Clock className="h-8 w-8 text-muted-foreground/30" />
            <div className="text-sm text-muted-foreground">暂无浏览记录</div>
            <div className="text-xs text-muted-foreground/50">
              访问页面后会自动记录
            </div>
          </div>
        ) : (
          <ScrollArea className="max-h-[22rem]">
            <div className="p-1.5">
              {recentPages.map((page, index) => (
                <RecentPageItem
                  key={page.path}
                  path={page.path}
                  title={page.title}
                  visitedAt={page.visitedAt}
                  isActive={false}
                  index={index}
                />
              ))}
            </div>
          </ScrollArea>
        )}
      </PopoverContent>
    </Popover>
  )
}
