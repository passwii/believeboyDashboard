'use client'

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ChatterEvent } from '@/lib/digital-employee/office-stream-types'
import styles from '@/components/digital-employee/digital-employee-warm.module.css'

const PRESENTATION_EVENT_STYLES: Record<string, string> = {
  task_completed: 'text-emerald-600 dark:text-emerald-400',
  task_failed: 'text-term-neg',
  task_started: 'text-blue-600 dark:text-blue-400',
  pause_started: 'text-term-warn',
  went_offline: 'text-muted-foreground',
  came_online: 'text-emerald-600 dark:text-emerald-400',
}

function timeAgo(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime()
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  return `${Math.floor(diff / 3_600_000)} 小时前`
}

export function OfficeChatterTicker({
  feed,
  presentation = false,
}: {
  feed: ChatterEvent[]
  presentation?: boolean
}) {
  if (feed.length === 0) return null
  const recent = feed.slice(0, 8)

  if (presentation) {
    return (
      <div className="overflow-hidden rounded-none border border-term-border bg-term-bg px-3 py-2">
        <div className="flex items-center gap-4 overflow-x-auto scrollbar-none">
          {recent.map((event, index) => (
            <span
              key={`${event.timestamp}-${event.employee_id}-${index}`}
              className={cn(
                'shrink-0 text-xs whitespace-nowrap',
                PRESENTATION_EVENT_STYLES[event.event_type] ?? 'text-muted-foreground',
                index === 0 && 'font-medium'
              )}
            >
              {event.emoji} {event.text}
              <span className="ml-1 text-[10px] text-muted-foreground/60">
                {timeAgo(event.timestamp)}
              </span>
            </span>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className={styles.chatterTicker}>
      <div className={styles.chatterList}>
        {recent.map((event, index) => (
          <span
            key={`${event.timestamp}-${event.employee_id}-${index}`}
            className={styles.chatterItem}
            data-event={event.event_type}
          >
            {event.emoji} {event.text}
            <span className={styles.chatterTime}>{timeAgo(event.timestamp)}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

export function OfficeSpotlightToast({
  feed,
  presentation = false,
}: {
  feed: ChatterEvent[]
  presentation?: boolean
}) {
  const [visible, setVisible] = useState<ChatterEvent | null>(null)
  const [lastSeen, setLastSeen] = useState<string>('')

  useEffect(() => {
    if (feed.length === 0) return
    const latest = feed[0]
    const key = `${latest.timestamp}-${latest.employee_id}`
    if (key === lastSeen) return

    if (latest.event_type === 'task_completed' || latest.event_type === 'task_failed') {
      setLastSeen(key)
      setVisible(latest)
      const timer = setTimeout(() => setVisible(null), 5000)
      return () => clearTimeout(timer)
    }
  }, [feed, lastSeen])

  if (!visible) return null

  const isFail = visible.event_type === 'task_failed'

  if (presentation) {
    return (
      <div
        className={cn(
          'fixed bottom-6 left-4 right-4 z-50 flex items-center gap-3 rounded-none border px-4 py-3 shadow-none',
          'animate-in slide-in-from-bottom-2 fade-in duration-[var(--duration-medium)]',
          'sm:left-auto sm:right-6',
          isFail
            ? 'border-term-neg/40 bg-term-bg text-term-neg'
            : 'border-term-pos/40 bg-term-bg text-term-pos'
        )}
        role="status"
        aria-live="polite"
      >
        <span className="text-xl">{visible.emoji}</span>
        <div className="leading-tight">
          <p className="text-sm font-medium">{visible.name}</p>
          <p className="text-xs opacity-80">{visible.text}</p>
        </div>
        <button
          onClick={() => setVisible(null)}
          className="ml-2 text-xs opacity-50 hover:opacity-100"
          aria-label="关闭"
        >
          ✕
        </button>
      </div>
    )
  }

  return (
    <div
      className={styles.spotlight}
      data-failed={isFail ? 'true' : undefined}
      role="status"
      aria-live="polite"
    >
      <span aria-hidden="true">{visible.emoji}</span>
      <div className={styles.spotlightCopy}>
        <p className={styles.spotlightName}>{visible.name}</p>
        <p className={styles.spotlightText}>{visible.text}</p>
      </div>
      <button
        type="button"
        onClick={() => setVisible(null)}
        className={styles.spotlightClose}
        aria-label="关闭"
      >
        <X aria-hidden="true" />
      </button>
    </div>
  )
}
