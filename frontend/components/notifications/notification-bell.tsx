'use client'

import { useRouter } from 'next/navigation'
import { Bell, CheckCheck } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useServerNotifications } from './use-server-notifications'
import type { ServerNotification } from '@/lib/notifications-api'

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  return `${Math.floor(hr / 24)} 天前`
}

function NotificationRow({
  n,
  onClick,
}: {
  n: ServerNotification
  onClick: (n: ServerNotification) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onClick(n)}
      className={`flex w-full items-start gap-2 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-muted ${
        n.read ? 'opacity-70' : 'bg-primary/5'
      }`}
    >
      {!n.read && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{n.title}</div>
        {n.message && <div className="truncate text-xs text-muted-foreground">{n.message}</div>}
        <div className="mt-0.5 text-xs text-muted-foreground">{timeAgo(n.created_at)}</div>
      </div>
    </button>
  )
}

export function NotificationBell() {
  const router = useRouter()
  const { unreadCount, items, loading, open, setOpen, markRead, markAllRead } =
    useServerNotifications()

  const handleClick = (n: ServerNotification) => {
    if (!n.read) void markRead(n.id)
    const link = n.data?.link
    setOpen(false)
    if (link) router.push(link)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="通知"
          className="fixed right-4 top-3 z-50 flex h-10 w-10 items-center justify-center rounded-xl border border-border/65 bg-[hsl(var(--surface-overlay)/0.85)] shadow-md backdrop-blur transition-colors hover:bg-muted"
        >
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <Badge className="absolute -right-1 -top-1 h-5 min-w-5 px-1 text-[0.65rem]">
              {unreadCount > 99 ? '99+' : unreadCount}
            </Badge>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[360px] p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <span className="text-sm font-semibold">通知</span>
          <Button size="sm" variant="ghost" onClick={() => void markAllRead()} disabled={unreadCount === 0}>
            <CheckCheck className="mr-1 h-3.5 w-3.5" /> 全部已读
          </Button>
        </div>
        <div className="max-h-[420px] overflow-y-auto p-2">
          {loading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">加载中…</div>
          ) : items.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">暂无通知</div>
          ) : (
            <div className="space-y-1">
              {items.map((n) => (
                <NotificationRow key={n.id} n={n} onClick={handleClick} />
              ))}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}