'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import type { DigitalEmployeeTask, DigitalEmployee } from '@/types/digital-employee'
import { fetchDigitalEmployees } from '@/lib/digital-employee-api'
import { fetchEmployeeTasks } from '@/lib/digital-employee-api'
import { PERSONA_MAP } from '@/components/digital-employee/persona'
import { cn } from '@/lib/utils'

const API_BASE = '/api/backend'

function resolveApiUrl(path: string) {
  const base = API_BASE.endsWith('/') ? API_BASE.slice(0, -1) : API_BASE
  return `${base}${path}`
}

export async function fetchAllRecentTasks(): Promise<{
  tasks: (DigitalEmployeeTask & { employee: DigitalEmployee })[]
}> {
  const { items: employees } = await fetchDigitalEmployees()
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const results = await Promise.allSettled(
    employees.map(async (emp) => {
      const res = await fetch(
        resolveApiUrl(`/api/v1/digital-employees/${emp.id}/tasks?page=1&page_size=5`),
        {
          cache: 'no-store',
        }
      )
      if (!res.ok) return []
      const data = await res.json()
      return (data.items as DigitalEmployeeTask[]).map((t) => ({ ...t, employee: emp }))
    })
  )

  const flat = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
  const sorted = flat.sort(
    (a, b) =>
      new Date(b.started_at ?? b.created_at).getTime() -
      new Date(a.started_at ?? a.created_at).getTime()
  )
  return { tasks: sorted.slice(0, 50) }
}

type ActivityEvent = {
  id: string
  employeeId: number
  employeeName: string
  employeeType: string
  avatarUrl: string | null
  taskId: string
  taskName: string
  taskStatus: string
  progressPercent: number
  currentStep: string | null
  eventType: 'started' | 'progress' | 'completed' | 'failed' | 'heartbeat'
  message: string
  timestamp: Date
}

function inferEventType(task: DigitalEmployeeTask): ActivityEvent['eventType'] {
  if (task.status === 'RUNNING') {
    if (!task.started_at) return 'started'
    return 'progress'
  }
  if (task.status === 'SUCCEEDED') return 'completed'
  if (task.status === 'FAILED') return 'failed'
  if (task.started_at) return 'heartbeat'
  return 'started'
}

function buildActivityMessage(task: DigitalEmployeeTask): string {
  if (task.status === 'RUNNING' && task.current_step) {
    return task.current_step
  }
  if (task.status === 'RUNNING') {
    return `执行中... ${task.progress_percent}%`
  }
  if (task.status === 'SUCCEEDED') {
    return task.current_step ? `✅ ${task.current_step}` : '✅ 任务已完成'
  }
  if (task.status === 'FAILED') {
    return task.error_message ?? task.current_step ?? '❌ 任务失败'
  }
  if (task.status === 'PENDING') {
    return '⏳ 等待执行'
  }
  if (task.status === 'CANCELLED') {
    return '⏸ 任务已取消'
  }
  return task.current_step ?? task.task_name
}

function tasksToActivities(
  tasks: (DigitalEmployeeTask & { employee: DigitalEmployee })[]
): ActivityEvent[] {
  return tasks
    .filter((t) => t.started_at || t.status === 'PENDING')
    .map((t) => ({
      id: `${t.id}-${t.status}`,
      employeeId: t.employee.id,
      employeeName: t.employee.name,
      employeeType: t.employee.employee_type,
      avatarUrl: t.employee.avatar_url,
      taskId: t.task_id,
      taskName: t.task_name,
      taskStatus: t.status,
      progressPercent: t.progress_percent,
      currentStep: t.current_step,
      eventType: inferEventType(t),
      message: buildActivityMessage(t),
      timestamp: t.started_at ? new Date(t.started_at) : new Date(t.created_at),
    }))
}

interface ActivityFeedProps {
  pollInterval?: number
  maxHeight?: string
  className?: string
  compact?: boolean
}

export function useActivityFeed(pollInterval = 15000) {
  const [activities, setActivities] = useState<ActivityEvent[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const { tasks } = await fetchAllRecentTasks()
      setActivities(tasksToActivities(tasks))
    } catch {
      // ignore
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const interval = setInterval(load, pollInterval)
    return () => clearInterval(interval)
  }, [load, pollInterval])

  return { activities, isLoading, mutate: load }
}

function formatRelativeTime(date: Date): string {
  const diff = Date.now() - date.getTime()
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return '刚刚'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  return `${days}天前`
}

const EVENT_STYLES: Record<
  ActivityEvent['eventType'],
  {
    icon: string
    color: string
    border: string
    label: string
    bg: string
  }
> = {
  started: {
    icon: '🚀',
    color: 'text-blue-600 dark:text-blue-400',
    border: 'border-blue-200 dark:border-blue-800',
    bg: 'bg-blue-50 dark:bg-blue-950/40',
    label: '启动',
  },
  progress: {
    icon: '⚡',
    color: 'text-blue-600 dark:text-blue-400',
    border: 'border-blue-200 dark:border-blue-800',
    bg: 'bg-blue-50 dark:bg-blue-950/40',
    label: '进行中',
  },
  completed: {
    icon: '✅',
    color: 'text-emerald-600 dark:text-emerald-400',
    border: 'border-emerald-200 dark:border-emerald-800',
    bg: 'bg-emerald-50 dark:bg-emerald-950/40',
    label: '完成',
  },
  failed: {
    icon: '❌',
    color: 'text-term-neg',
    border: 'border-term-neg/30',
    bg: 'bg-term-neg/5',
    label: '失败',
  },
  heartbeat: {
    icon: '💓',
    color: 'text-muted-foreground',
    border: 'border-muted',
    bg: 'bg-muted/40',
    label: '心跳',
  },
}

function ProgressBar({ percent }: { percent: number }) {
  return (
    <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full bg-blue-500 transition-all duration-700"
        style={{ width: `${percent}%` }}
      />
    </div>
  )
}

function ActivityItem({ activity, compact }: { activity: ActivityEvent; compact?: boolean }) {
  const style = EVENT_STYLES[activity.eventType]
  const persona = PERSONA_MAP[activity.employeeType] || PERSONA_MAP.CUSTOM
  const avatar = activity.avatarUrl || persona.emoji

  return (
    <div
      className={cn(
        'group relative flex gap-3 rounded-xl border p-3 transition-all duration-300',
        'hover:shadow-sm hover:-translate-y-0.5',
        style.border,
        style.bg,
        compact ? 'py-2.5' : ''
      )}
    >
      {/* Timeline dot */}
      <div
        className={cn(
          'absolute -left-1.5 top-4 h-3 w-3 rounded-full border-2',
          style.border.replace('border-', 'bg-'),
          'bg-background'
        )}
      />

      {/* Avatar */}
      <div className="relative shrink-0">
        <div
          className={cn(
            'flex items-center justify-center rounded-xl border text-xl',
            compact ? 'h-9 w-9 text-lg' : 'h-11 w-11 text-2xl'
          )}
          style={{
            background: `linear-gradient(135deg, hsl(var(--${persona.color.split('-')[1]}-500)/.08) 0%, hsl(var(--${persona.color.split('-')[1]}-500)/.03) 100%)`,
            borderColor: `hsl(var(--${persona.color.split('-')[1]}-500)/.2)`,
          }}
        >
          {avatar}
        </div>
        <span className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full border bg-background text-[10px] shadow-sm">
          {style.icon}
        </span>
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        {/* Header */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="truncate text-sm font-semibold">{activity.employeeName}</span>
            <span
              className={cn(
                'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
                style.bg,
                style.color
              )}
            >
              {style.label}
            </span>
          </div>
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {formatRelativeTime(activity.timestamp)}
          </span>
        </div>

        {/* Task name */}
        <p
          className={cn('mt-0.5 text-xs text-muted-foreground truncate', compact && 'text-[11px]')}
        >
          {activity.taskName}
        </p>

        {/* Message */}
        <p
          className={cn(
            'mt-1 text-sm leading-relaxed',
            activity.eventType === 'failed'
              ? 'text-term-neg font-medium'
              : 'text-foreground/80'
          )}
        >
          {activity.message}
        </p>

        {/* Progress bar for running tasks */}
        {activity.eventType === 'progress' && activity.progressPercent > 0 && (
          <ProgressBar percent={activity.progressPercent} />
        )}
      </div>
    </div>
  )
}

export function ActivityFeed({
  pollInterval = 15000,
  maxHeight = '600px',
  className,
  compact = false,
}: ActivityFeedProps) {
  const { activities, isLoading } = useActivityFeed(pollInterval)
  const scrollRef = useRef<HTMLDivElement>(null)

  if (isLoading) {
    return (
      <div className={cn('space-y-2', className)}>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex gap-3 rounded-xl border p-3">
            <div className="h-11 w-11 rounded-xl bg-muted animate-pulse shrink-0" />
            <div className="flex-1 space-y-2 pt-1">
              <div className="h-3 w-24 rounded bg-muted animate-pulse" />
              <div className="h-3 w-40 rounded bg-muted animate-pulse" />
              <div className="h-3 w-full rounded bg-muted animate-pulse" />
            </div>
          </div>
        ))}
      </div>
    )
  }

  if (activities.length === 0) {
    return (
      <div
        className={cn(
          'flex flex-col items-center justify-center rounded-xl border border-dashed py-12 text-muted-foreground',
          className
        )}
      >
        <span className="text-3xl">🤖</span>
        <p className="mt-2 text-sm">暂无活动记录</p>
        <p className="text-xs">数字员工正在待命...</p>
      </div>
    )
  }

  return (
    <div
      ref={scrollRef}
      className={cn('space-y-2 overflow-y-auto pr-1', className)}
      style={{ maxHeight }}
    >
      {activities.map((activity) => (
        <ActivityItem key={activity.id} activity={activity} compact={compact} />
      ))}
    </div>
  )
}
