'use client'

import { useEffect, useMemo, useState } from 'react'
import { usePathname } from 'next/navigation'
import { Wifi } from 'lucide-react'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { getDashboardPageTitle } from '@/lib/dashboard-route-meta'
import { cn } from '@/lib/utils'

const MAX_VISIBLE_USERS = 5
const HEARTBEAT_INTERVAL_MS = 25_000

type PresenceUser = {
  user_id: string
  display_name: string
  email: string | null
  avatar_url: string | null
  current_path: string
  current_page_title: string
  last_seen_at: string
  is_current_user: boolean
}

type PresenceResponse = {
  items: PresenceUser[]
  server_time: string
}

function getInitials(name: string) {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)

  if (parts.length === 0) return '?'
  return parts.map((part) => part[0]?.toUpperCase() ?? '').join('')
}

async function sendHeartbeat(pathname: string, currentPageTitle: string) {
  const response = await fetch('/api/backend/api/v1/system-management/presence/heartbeat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      current_path: pathname,
      current_page_title: currentPageTitle,
    }),
    cache: 'no-store',
  })

  if (!response.ok) {
    throw new Error('presence heartbeat failed')
  }
  return (await response.json()) as PresenceResponse
}

export function LivePresence() {
  const pathname = usePathname()
  const currentPageTitle = useMemo(() => getDashboardPageTitle(pathname), [pathname])
  const [items, setItems] = useState<PresenceUser[]>([])
  const [isLoaded, setIsLoaded] = useState(false)

  useEffect(() => {
    let isDisposed = false

    const syncPresence = async () => {
      try {
        const payload = await sendHeartbeat(pathname, currentPageTitle)
        if (!isDisposed) {
          setItems(payload.items)
          setIsLoaded(true)
        }
      } catch {
        if (!isDisposed) {
          setIsLoaded(true)
        }
      }
    }

    void syncPresence()
    const timer = window.setInterval(() => {
      void syncPresence()
    }, HEARTBEAT_INTERVAL_MS)

    return () => {
      isDisposed = true
      window.clearInterval(timer)
    }
  }, [pathname, currentPageTitle])

  const visibleUsers = items.slice(0, MAX_VISIBLE_USERS)
  const overflowUsers = items.slice(MAX_VISIBLE_USERS)

  if (isLoaded && items.length === 0) {
    return null
  }

  return (
    <TooltipProvider delayDuration={120}>
      <div className="hidden items-center gap-3 xl:flex">
        <div className="flex items-center gap-2 rounded-2xl border border-border/60 bg-[hsl(var(--surface-subtle))] px-3 py-2 shadow-[inset_0_1px_0_hsl(var(--background)/0.4)]">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inset-0 rounded-full bg-emerald-500/25 blur-[1px]" />
              <span className="relative h-2.5 w-2.5 rounded-full bg-emerald-500" />
            </span>
            <Wifi className="h-3.5 w-3.5 text-emerald-600" />
            <span>在线协作</span>
          </div>
          <div className="flex items-center pl-1">
            {visibleUsers.map((user) => (
              <Tooltip key={user.user_id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="relative -ml-2 first:ml-0 rounded-full transition-transform duration-200 hover:z-10 hover:-translate-y-0.5 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={`${user.display_name} 当前正在查看 ${user.current_page_title}`}
                  >
                    <Avatar className="h-9 w-9 border-2 border-[hsl(var(--surface-subtle))] bg-[hsl(var(--surface-panel))] shadow-sm">
                      {user.avatar_url ? <AvatarImage src={user.avatar_url} alt={user.display_name} /> : null}
                      <AvatarFallback className="bg-[linear-gradient(135deg,hsl(var(--primary)/0.18),hsl(var(--secondary)/0.22))] text-[0.72rem] font-semibold text-foreground">
                        {getInitials(user.display_name)}
                      </AvatarFallback>
                    </Avatar>
                    <span
                      className={cn(
                        'absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-[hsl(var(--surface-subtle))] bg-emerald-500',
                        user.is_current_user ? 'shadow-[0_0_0_2px_rgba(16,185,129,0.18)]' : ''
                      )}
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-[16rem] rounded-xl px-3 py-2">
                  <div className="space-y-0.5">
                    <p className="text-sm font-semibold text-foreground">
                      {user.display_name}
                      {user.is_current_user ? ' · 你' : ''}
                    </p>
                    <p className="text-xs text-muted-foreground">当前页面：{user.current_page_title}</p>
                  </div>
                </TooltipContent>
              </Tooltip>
            ))}
            {overflowUsers.length > 0 ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="-ml-2 inline-flex h-9 min-w-9 items-center justify-center rounded-full border-2 border-[hsl(var(--surface-subtle))] bg-[hsl(var(--surface-panel))] px-2 text-xs font-semibold text-muted-foreground shadow-sm transition-transform duration-200 hover:z-10 hover:-translate-y-0.5 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={`还有 ${overflowUsers.length} 位在线用户`}
                  >
                    +{overflowUsers.length}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-[18rem] rounded-xl px-3 py-2">
                  <div className="space-y-1.5">
                    {overflowUsers.map((user) => (
                      <p key={user.user_id} className="text-xs text-muted-foreground">
                        <span className="font-semibold text-foreground">{user.display_name}</span>
                        {' · '}
                        {user.current_page_title}
                      </p>
                    ))}
                  </div>
                </TooltipContent>
              </Tooltip>
            ) : null}
          </div>
        </div>
      </div>
    </TooltipProvider>
  )
}
