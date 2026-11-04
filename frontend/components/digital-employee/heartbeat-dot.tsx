'use client'

import styles from './digital-employee-warm.module.css'

interface HeartbeatDotProps {
  lastSeen: string | null
  showLabel?: boolean
}

function getMinutesAgo(date: string | null): number | null {
  if (!date) return null
  return Math.floor((Date.now() - new Date(date).getTime()) / 60000)
}

function formatRelativeTime(minutes: number): string {
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分钟前`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}小时前`
  return `${Math.floor(minutes / 1440)}天前`
}

export function HeartbeatDot({ lastSeen, showLabel = true }: HeartbeatDotProps) {
  const minutes = getMinutesAgo(lastSeen)

  const age = minutes === null ? 'none' : minutes < 5 ? 'fresh' : minutes < 30 ? 'active' : 'stale'

  const label = minutes !== null ? formatRelativeTime(minutes) : '无数据'

  return (
    <div className={styles.heartbeat}>
      <span className={styles.heartbeatDot} data-age={age} aria-hidden="true" />
      {showLabel && <span>最后活跃 {label}</span>}
    </div>
  )
}
