'use client'

import { useEffect, useState } from 'react'
import {
  CheckCircle2,
  Info,
  AlertTriangle,
  XCircle,
  Bell,
  Trash2,
} from 'lucide-react'
import { Notification, NotificationType } from '@/lib/notifications'
import { useNotifications } from './notifications-context'
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

const typeConfig: Record<
  NotificationType,
  { icon: typeof CheckCircle2; className: string; dotClassName: string }
> = {
  success: {
    icon: CheckCircle2,
    className: 'text-emerald-500',
    dotClassName: 'bg-emerald-500',
  },
  error: {
    icon: XCircle,
    className: 'text-rose-500',
    dotClassName: 'bg-rose-500',
  },
  warning: {
    icon: AlertTriangle,
    className: 'text-amber-500',
    dotClassName: 'bg-amber-500',
  },
  info: {
    icon: Info,
    className: 'text-blue-500',
    dotClassName: 'bg-blue-500',
  },
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (seconds < 60) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  if (hours < 24) return `${hours} 小时前`
  if (days < 7) return `${days} 天前`
  return new Date(timestamp).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

interface GroupedNotifications {
  today: Notification[]
  earlier: Notification[]
}

function groupByTime(notifications: Notification[]): GroupedNotifications {
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()

  return notifications.reduce(
    (acc, n) => {
      if (n.createdAt >= todayStart) {
        acc.today.push(n)
      } else {
        acc.earlier.push(n)
      }
      return acc
    },
    { today: [] as Notification[], earlier: [] as Notification[] }
  )
}

interface NotificationItemProps {
  notification: Notification
  onMarkRead: (id: string) => void
}

function NotificationItem({ notification, onMarkRead }: NotificationItemProps) {
  const config = typeConfig[notification.type]
  const Icon = config.icon

  return (
    <button
      type="button"
      onClick={() => onMarkRead(notification.id)}
      className={cn(
        'group flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-[hsl(var(--surface-subtle))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        !notification.read && 'bg-[hsl(var(--surface-subtle)/0.5)]'
      )}
    >
      <div className="mt-0.5 shrink-0">
        <Icon className={cn('h-4 w-4', config.className)} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p
            className={cn(
              'text-sm font-medium leading-snug text-foreground',
              !notification.read && 'font-semibold'
            )}
          >
            {notification.title}
          </p>
          {!notification.read && (
            <span className={cn('h-2 w-2 shrink-0 rounded-full', config.dotClassName)} />
          )}
        </div>
        {notification.message ? (
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {notification.message}
          </p>
        ) : null}
        <p className="mt-1 text-[0.7rem] text-muted-foreground/60">
          {formatRelativeTime(notification.createdAt)}
        </p>
      </div>
    </button>
  )
}

interface NotificationPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function NotificationPanel({ open, onOpenChange }: NotificationPanelProps) {
  const { history, markRead, clearAll } = useNotifications()
  const [grouped, setGrouped] = useState<GroupedNotifications>({ today: [], earlier: [] })

  useEffect(() => {
    setGrouped(groupByTime(history))
  }, [history])

  const hasNotifications = history.length > 0

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-80 flex-col p-0 sm:max-w-sm">
        <div className="flex items-center justify-between px-4 py-4">
          <div className="flex items-center gap-2">
            <Bell className="h-4 w-4" />
            <SheetTitle>通知中心</SheetTitle>
          </div>
          {hasNotifications && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              onClick={clearAll}
            >
              <Trash2 className="h-3 w-3" />
              清空全部
            </Button>
          )}
        </div>

        <ScrollArea className="flex-1">
          {!hasNotifications ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="mb-3 rounded-full bg-[hsl(var(--surface-subtle))] p-4">
                <Bell className="h-6 w-6 text-muted-foreground/50" />
              </div>
              <p className="text-sm font-medium text-muted-foreground">暂无通知</p>
              <p className="mt-1 text-xs text-muted-foreground/60">
                操作结果将显示在这里
              </p>
            </div>
          ) : (
            <div className="py-2">
              {grouped.today.length > 0 && (
                <div className="mb-2 px-3 pt-1">
                  <p className="text-[0.68rem] font-semibold uppercase tracking-wider text-muted-foreground/60">
                    今天
                  </p>
                </div>
              )}
              {grouped.today.map((n) => (
                <NotificationItem
                  key={n.id}
                  notification={n}
                  onMarkRead={markRead}
                />
              ))}

              {grouped.earlier.length > 0 && (
                <div className="mb-2 px-3 pt-3">
                  <p className="text-[0.68rem] font-semibold uppercase tracking-wider text-muted-foreground/60">
                    更早
                  </p>
                </div>
              )}
              {grouped.earlier.map((n) => (
                <NotificationItem
                  key={n.id}
                  notification={n}
                  onMarkRead={markRead}
                />
              ))}
            </div>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
