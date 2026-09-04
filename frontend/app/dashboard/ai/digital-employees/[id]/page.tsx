'use client'

import { useState, useEffect, useCallback, use } from 'react'
import { ArrowLeft, Pause, Play } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import {
  fetchDigitalEmployee,
  fetchEmployeeTasks,
  suspendEmployee,
  resumeEmployee,
} from '@/lib/digital-employee-api'
import { EmployeeAvatar, getPersona } from '@/components/digital-employee/persona'
import { StatusBadge } from '@/components/digital-employee/status-badge'
import { HeartbeatDot } from '@/components/digital-employee/heartbeat-dot'
import { LiveLog } from '@/components/digital-employee/live-log'
import { cn } from '@/lib/utils'

/** BLF-838：任务状态 → 终端单色语义（pill 底改 1px 边界） */
const TASK_STATUS_STYLES: Record<string, string> = {
  PENDING: 'border-term-border bg-term-bg text-term-faint',
  RUNNING: 'border-term-accent/40 text-term-accent',
  SUCCEEDED: 'border-term-pos/40 text-term-pos',
  FAILED: 'border-term-neg/40 text-term-neg',
  CANCELLED: 'border-term-warn/40 text-term-warn',
}

const TASK_STATUS_ICON: Record<string, string> = {
  PENDING: '⏳',
  RUNNING: '⚡',
  SUCCEEDED: '✅',
  FAILED: '❌',
  CANCELLED: '⏸',
}

export default function EmployeeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const employeeId = parseInt(id, 10)

  const [employee, setEmployee] = useState<
    import('@/types/digital-employee').DigitalEmployee | null
  >(null)
  const [tasks, setTasks] = useState<import('@/types/digital-employee').DigitalEmployeeTask[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isActing, setIsActing] = useState(false)
  const [taskPage, setTaskPage] = useState(1)

  const load = useCallback(async () => {
    try {
      const [emp, taskData] = await Promise.all([
        fetchDigitalEmployee(employeeId),
        fetchEmployeeTasks(employeeId),
      ])
      setEmployee(emp)
      setTasks(taskData.items)
    } catch {
      // ignore
    } finally {
      setIsLoading(false)
    }
  }, [employeeId])

  useEffect(() => {
    void load()
    const interval = setInterval(load, 15000)
    return () => clearInterval(interval)
  }, [load])

  async function handleSuspend() {
    setIsActing(true)
    try {
      await suspendEmployee(employeeId)
      setEmployee((prev) => (prev ? { ...prev, status: 'SUSPENDED' } : null))
    } finally {
      setIsActing(false)
    }
  }

  async function handleResume() {
    setIsActing(true)
    try {
      await resumeEmployee(employeeId)
      setEmployee((prev) => (prev ? { ...prev, status: 'IDLE' } : null))
    } finally {
      setIsActing(false)
    }
  }

  if (isLoading) {
    return (
      <div className="flex min-w-0 flex-col gap-3">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-32 w-full rounded-none border border-term-border" />
        <div className="grid grid-cols-1 lg:grid-cols-[1fr,380px] gap-6">
          <div className="space-y-4">
            <Skeleton className="h-48 w-full rounded-none border border-term-border" />
            <Skeleton className="h-64 w-full rounded-none border border-term-border" />
          </div>
          <div className="space-y-4">
            <Skeleton className="h-64 w-full rounded-none border border-term-border" />
            <Skeleton className="h-48 w-full rounded-none border border-term-border" />
          </div>
        </div>
      </div>
    )
  }

  if (!employee) {
    return (
      <div className="flex items-center justify-center p-8 text-muted-foreground">
        数字员工不存在
      </div>
    )
  }

  const persona = getPersona(employee.employee_type)
  const runningTask = tasks.find((t) => t.status === 'RUNNING')

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Button variant="ghost" size="sm" onClick={() => router.back()} className="h-7 w-fit gap-1.5 rounded-none border border-transparent font-mono text-xs leading-5 text-term-muted hover:border-term-border hover:text-term-text">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
        返回列表
      </Button>

      <div className="rounded-none border border-term-border bg-term-panel p-4 sm:p-6">
        <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:gap-5">
          <EmployeeAvatar
            employeeType={employee.employee_type}
            size="xl"
            status={employee.status}
          />
          <div className="flex-1 min-w-0">
            <h1 className="truncate text-base font-semibold text-term-text">{employee.name}</h1>
            <p className="mt-1 font-mono text-xs text-term-muted">
              {employee.employee_type.replace(/_/g, ' ').toLowerCase()} · {persona.tagline}
            </p>
            <div className="flex items-center gap-3 mt-2">
              <StatusBadge status={employee.status} />
              <HeartbeatDot lastSeen={employee.last_heartbeat_at} />
            </div>
          </div>
          <div className="flex w-full gap-2 sm:w-auto">
            {employee.status === 'SUSPENDED' ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleResume()}
                disabled={isActing}
              >
                <Play className="h-4 w-4 mr-1" /> 恢复
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleSuspend()}
                disabled={isActing}
              >
                <Pause className="h-4 w-4 mr-1" /> 暂停
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr,380px] gap-3">
        <div className="space-y-3">
          {runningTask && (
            <div className="rounded-none border border-term-border bg-term-panel p-3">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-mono text-xs font-semibold uppercase tracking-wider text-term-muted">当前任务</h3>
                <span className="font-mono text-xs text-term-faint">
                  进行中 {runningTask.started_at ? formatDuration(runningTask.started_at) : ''}
                </span>
              </div>
              <p className="mb-2 truncate text-sm font-medium text-term-text">{runningTask.task_name}</p>
              <div className="mb-2 h-1.5 w-full overflow-hidden rounded-none border border-term-border bg-term-bg">
                <div
                  className="h-full bg-term-accent transition-all duration-700"
                  style={{ width: `${runningTask.progress_percent}%` }}
                />
              </div>
              <div className="flex justify-between gap-2 font-mono text-xs text-term-muted">
                <span className="truncate">{runningTask.current_step || '处理中…'}</span>
                <span className="shrink-0 font-medium tabular-nums text-term-accent">{runningTask.progress_percent}%</span>
              </div>
            </div>
          )}

          <div className="rounded-none border border-term-border bg-term-panel p-3">
            <h3 className="mb-3 font-mono text-xs font-semibold uppercase tracking-wider text-term-muted">任务历史</h3>
            {tasks.length === 0 ? (
              <p className="py-4 text-center font-mono text-xs text-term-faint">暂无任务记录</p>
            ) : (
              <div className="space-y-2">
                {tasks.slice(0, taskPage * 10).map((task) => (
                  <div
                    key={task.id}
                    className="flex items-center gap-3 rounded-none border border-term-border p-3 transition-colors hover:bg-term-hover"
                  >
                    <span className="text-base shrink-0">
                      {TASK_STATUS_ICON[task.status] || '⏳'}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{task.task_name}</p>
                      <p className="text-xs text-muted-foreground">
                        {task.started_at ? new Date(task.started_at).toLocaleString('zh-CN') : '—'}
                        {task.error_message && (
                          <span className="ml-2 text-term-neg">{task.error_message}</span>
                        )}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge variant="outline" className={cn('rounded-none font-mono text-[10px]', TASK_STATUS_STYLES[task.status])}>
                        {task.status}
                      </Badge>
                      {task.status === 'RUNNING' && (
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {task.progress_percent}%
                        </span>
                      )}
                    </div>
                  </div>
                ))}
                {tasks.length > taskPage * 10 && (
                  <button
                    onClick={() => setTaskPage((p) => p + 1)}
                    className="mt-2 w-full rounded-none border border-dashed border-term-border py-2 font-mono text-xs text-term-muted transition-colors hover:border-term-border-strong hover:text-term-text"
                  >
                    加载更多
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="space-y-3">
          <div className="rounded-none border border-term-border bg-term-panel p-3">
            <div className="flex items-center gap-2 mb-3">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-term-pos opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-term-pos" />
              </span>
              <h3 className="font-mono text-xs font-semibold uppercase tracking-wider text-term-muted">实时日志</h3>
            </div>
            <LiveLog employeeId={employeeId} maxItems={20} className="max-h-[400px]" />
          </div>

          <div className="rounded-none border border-term-border bg-term-panel p-3">
            <h3 className="mb-3 font-mono text-xs font-semibold uppercase tracking-wider text-term-muted">员工信息</h3>
            <div className="space-y-2.5 text-sm">
              <InfoRow
                label="类型"
                value={employee.employee_type.replace(/_/g, ' ').toLowerCase()}
              />
              <InfoRow label="角色" value={persona.tagline} />
              <InfoRow
                label="静默阈值"
                value={`${employee.is_silent_alert_threshold_minutes} 分钟`}
              />
              <InfoRow
                label="创建时间"
                value={new Date(employee.created_at).toLocaleDateString('zh-CN')}
              />
              {employee.description && <InfoRow label="描述" value={employee.description} />}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-term-border py-1.5 last:border-0">
      <span className="shrink-0 font-mono text-xs text-term-muted">{label}</span>
      <span className="truncate text-right font-mono text-xs text-term-text">{value}</span>
    </div>
  )
}

function formatDuration(startedAt: string): string {
  const minutes = Math.floor((Date.now() - new Date(startedAt).getTime()) / 60000)
  if (minutes < 1) return '不到 1 分钟'
  if (minutes < 60) return `${minutes} 分钟`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`
}
