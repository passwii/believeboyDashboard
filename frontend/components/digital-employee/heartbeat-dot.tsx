'use client'

import { useMemo } from 'react'

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

  const color = useMemo(() => {
    if (minutes === null) return 'bg-muted'
    if (minutes < 1) return 'bg-emerald-500'
    if (minutes < 5) return 'bg-blue-500'
    if (minutes < 30) return 'bg-amber-500'
    return 'bg-red-500'
  }, [minutes])

  const label = minutes !== null ? formatRelativeTime(minutes) : '无数据'

  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className={`h-2 w-2 rounded-full ${color}`} />
      {showLabel && <span>最后活跃 {label}</span>}
    </div>
  )
}
