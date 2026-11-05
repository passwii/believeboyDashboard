'use client'

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import type { ChatterEvent } from '@/lib/digital-employee/office-stream-types'
import styles from '@/components/digital-employee/digital-employee-warm.module.css'

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

  return (
    <div
      className={`${styles.chatterTicker} ${presentation ? styles.chatterTickerPresentation : ''}`}
      data-presentation={presentation ? 'true' : undefined}
    >
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

  return (
    <div
      className={`${styles.spotlight} ${presentation ? styles.spotlightPresentation : ''}`}
      data-failed={isFail ? 'true' : undefined}
      data-presentation={presentation ? 'true' : undefined}
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
