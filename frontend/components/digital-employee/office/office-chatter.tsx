'use client'
import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import type { ChatterEvent } from '@/lib/digital-employee/office-stream-types'

/** 事件类型 → 样式映射 */
const EVENT_STYLES: Record<string, string> = {
  task_completed: 'text-emerald-600 dark:text-emerald-400',
  task_failed: 'text-red-600 dark:text-red-400',
  task_started: 'text-blue-600 dark:text-blue-400',
  pause_started: 'text-amber-600 dark:text-amber-400',
  went_offline: 'text-muted-foreground',
  came_online: 'text-emerald-600 dark:text-emerald-400',
}

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime()
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  return `${Math.floor(diff / 3_600_000)} 小时前`
}

/** 底部 ticker 信息流：最近 N 条 chatter 横向滚动 */
export function OfficeChatterTicker({ feed }: { feed: ChatterEvent[] }) {
  if (feed.length === 0) return null
  const recent = feed.slice(0, 8)

  return (
    <div className="overflow-hidden rounded-none border border-term-border bg-term-bg px-3 py-2">
      <div className="flex items-center gap-4 overflow-x-auto scrollbar-none">
        {recent.map((evt, i) => (
          <span
            key={`${evt.timestamp}-${evt.employee_id}-${i}`}
            className={cn(
              'shrink-0 text-xs whitespace-nowrap',
              EVENT_STYLES[evt.event_type] ?? 'text-muted-foreground',
              i === 0 && 'font-medium',
            )}
          >
            {evt.emoji} {evt.text}
            <span className="ml-1 text-[10px] text-muted-foreground/60">{timeAgo(evt.timestamp)}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

/** Spotlight Toast：大事件（完成/失败）瞬态高亮，5s 后自动消失 */
export function OfficeSpotlightToast({ feed }: { feed: ChatterEvent[] }) {
  const [visible, setVisible] = useState<ChatterEvent | null>(null)
  const [lastSeen, setLastSeen] = useState<string>('')

  useEffect(() => {
    if (feed.length === 0) return
    const latest = feed[0]
    const key = `${latest.timestamp}-${latest.employee_id}`
    if (key === lastSeen) return

    // 只对 task_completed / task_failed 弹 toast
    if (latest.event_type === 'task_completed' || latest.event_type === 'task_failed') {
      setLastSeen(key)
      setVisible(latest)
      const timer = setTimeout(() => setVisible(null), 5000)
      return () => clearTimeout(timer)
    }
  }, [feed, lastSeen])

  if (!visible) return null

  const isFail = visible.event_type === 'task_failed'

  return (
    <div
      className={cn(
        'fixed bottom-6 left-4 right-4 z-50 flex items-center gap-3 rounded-none border px-4 py-3 shadow-none',
        'animate-in slide-in-from-bottom-2 fade-in duration-300',
        'sm:left-auto sm:right-6',
        isFail
          ? 'border-term-neg/40 bg-term-bg text-term-neg'
          : 'border-term-pos/40 bg-term-bg text-term-pos',
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
