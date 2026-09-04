'use client'

import { useEffect, useState, useCallback } from 'react'
import type { DigitalEmployeeLog } from '@/types/digital-employee'
import { fetchEmployeeRecentLogs } from '@/lib/digital-employee-api'
import { cn } from '@/lib/utils'

interface LiveLogProps {
  employeeId: number
  pollInterval?: number
  maxItems?: number
  className?: string
}

const LEVEL_STYLES: Record<string, { dot: string; border: string; text: string }> = {
  info: { dot: 'bg-term-accent', border: 'border-l-term-accent', text: 'text-term-text' },
  warn: {
    dot: 'bg-term-warn',
    border: 'border-l-term-warn',
    text: 'text-term-warn',
  },
  error: { dot: 'bg-term-neg', border: 'border-l-term-neg', text: 'text-term-neg' },
  debug: {
    dot: 'bg-term-faint',
    border: 'border-l-term-border',
    text: 'text-term-faint',
  },
}

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return '刚刚'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时前`
  return `${Math.floor(hours / 24)}天前`
}

export function LiveLog({
  employeeId,
  pollInterval = 15000,
  maxItems = 20,
  className,
}: LiveLogProps) {
  const [logs, setLogs] = useState<DigitalEmployeeLog[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const { items } = await fetchEmployeeRecentLogs(employeeId, maxItems)
      setLogs(items)
    } catch {
      // ignore
    } finally {
      setIsLoading(false)
    }
  }, [employeeId, maxItems])

  useEffect(() => {
    void load()
    const interval = setInterval(load, pollInterval)
    return () => clearInterval(interval)
  }, [load, pollInterval])

  if (isLoading) {
    return (
      <div className={cn('space-y-2', className)}>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-10 rounded-none border border-term-border bg-term-raised animate-pulse" />
        ))}
      </div>
    )
  }

  if (logs.length === 0) {
    return (
      <div
        className={cn(
          'flex flex-col items-center justify-center rounded-none border border-dashed border-term-border py-8 text-term-faint',
          className
        )}
      >
        <span className="text-2xl mb-2">📋</span>
        <p className="font-mono text-xs">暂无日志记录</p>
      </div>
    )
  }

  return (
    <div className={cn('space-y-1.5 overflow-y-auto', className)}>
      {logs.map((log) => {
        const style = LEVEL_STYLES[log.level.toLowerCase()] || LEVEL_STYLES.info
        return (
          <div
            key={log.id}
            className={cn(
              'rounded-none border border-term-border border-l-2 bg-term-bg px-3 py-2 transition-colors hover:bg-term-hover',
              style.border
            )}
          >
            <div className="flex items-start justify-between gap-2">
              <p className={cn('text-sm leading-relaxed flex-1', style.text)}>{log.message}</p>
              <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                {formatRelativeTime(log.created_at)}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
