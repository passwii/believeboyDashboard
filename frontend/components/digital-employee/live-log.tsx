'use client'

import { useEffect, useState, useCallback } from 'react'
import { ClipboardList } from 'lucide-react'
import type { DigitalEmployeeLog } from '@/types/digital-employee'
import { fetchEmployeeRecentLogs } from '@/lib/digital-employee-api'
import { cn } from '@/lib/utils'

import styles from './digital-employee-warm.module.css'

interface LiveLogProps {
  employeeId: number
  pollInterval?: number
  maxItems?: number
  className?: string
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
      <div className={cn(styles.logList, className)} aria-busy="true">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className={cn(styles.skeleton, styles.logSkeleton)} />
        ))}
      </div>
    )
  }

  if (logs.length === 0) {
    return (
      <div
        className={cn(styles.logEmpty, className)}
      >
        <ClipboardList aria-hidden="true" />
        <p>暂无日志记录</p>
      </div>
    )
  }

  return (
    <div className={cn(styles.logList, className)} data-testid="digital-employee-live-log">
      {logs.map((log) => {
        const level = log.level.toLowerCase()
        return (
          <div
            key={log.id}
            className={styles.logRow}
            data-level={level}
          >
            <div className={styles.logTop}>
              <p className={styles.logMessage}>{log.message}</p>
              <span className={styles.logTime}>
                {formatRelativeTime(log.created_at)}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
