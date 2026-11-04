'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import {
  Activity,
  CheckCircle2,
  HeartPulse,
  Rocket,
  XCircle,
  Zap,
} from 'lucide-react'
import type { DigitalEmployeeTask, DigitalEmployee } from '@/types/digital-employee'
import { fetchDigitalEmployees } from '@/lib/digital-employee-api'
import {
  WarmBadge,
  type WarmBadgeTone,
} from '@/components/dashboard-v2/warm-ledger/controls'
import { cn } from '@/lib/utils'

import styles from './digital-employee-warm.module.css'

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

const EVENT_PRESENTATION: Record<
  ActivityEvent['eventType'],
  {
    icon: typeof Rocket
    label: string
    tone: WarmBadgeTone
  }
> = {
  started: {
    icon: Rocket,
    label: '启动',
    tone: 'accent',
  },
  progress: {
    icon: Zap,
    label: '进行中',
    tone: 'accent',
  },
  completed: {
    icon: CheckCircle2,
    label: '完成',
    tone: 'positive',
  },
  failed: {
    icon: XCircle,
    label: '失败',
    tone: 'negative',
  },
  heartbeat: {
    icon: HeartPulse,
    label: '心跳',
    tone: 'neutral',
  },
}

function ProgressBar({ percent }: { percent: number }) {
  return (
    <div className={styles.activityProgress}>
      <div
        className={styles.activityProgressBar}
        style={{ width: `${percent}%` }}
      />
    </div>
  )
}

function ActivityItem({ activity, compact }: { activity: ActivityEvent; compact?: boolean }) {
  const presentation = EVENT_PRESENTATION[activity.eventType]
  const EventIcon = presentation.icon

  return (
    <div
      className={styles.activityItem}
      data-event={activity.eventType}
      data-compact={compact || undefined}
    >
      <div className={styles.activityIcon}>
        <EventIcon aria-hidden="true" />
      </div>

      <div className={styles.activityCopy}>
        <div className={styles.activityIdentity}>
          <strong>{activity.employeeName}</strong>
          <WarmBadge tone={presentation.tone}>{presentation.label}</WarmBadge>
          <span className={styles.activityTime}>
            {formatRelativeTime(activity.timestamp)}
          </span>
        </div>

        <p className={styles.activityTask}>{activity.taskName}</p>

        <p className={styles.activityMessage}>{activity.message}</p>

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
      <div className={cn(styles.activityList, className)} aria-busy="true">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className={styles.activitySkeleton}>
            <div className={cn(styles.skeleton, styles.activityAvatarSkeleton)} />
            <div className={styles.activityTextSkeleton}>
              <span className={styles.skeleton} />
              <span className={styles.skeleton} />
              <span className={styles.skeleton} />
            </div>
          </div>
        ))}
      </div>
    )
  }

  if (activities.length === 0) {
    return (
      <div
        className={cn(styles.activityEmpty, className)}
      >
        <Activity aria-hidden="true" />
        <p>暂无活动记录</p>
        <p>数字员工正在待命...</p>
      </div>
    )
  }

  return (
    <div
      ref={scrollRef}
      className={cn(styles.activityList, className)}
      data-testid="digital-employee-activity-list"
      style={{ maxHeight }}
    >
      {activities.map((activity) => (
        <ActivityItem key={activity.id} activity={activity} compact={compact} />
      ))}
    </div>
  )
}
