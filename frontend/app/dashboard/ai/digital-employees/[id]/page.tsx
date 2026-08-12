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

const TASK_STATUS_STYLES: Record<string, string> = {
  PENDING: 'bg-muted/60 text-muted-foreground',
  RUNNING: 'bg-blue-500/10 text-blue-600',
  SUCCEEDED: 'bg-emerald-500/10 text-emerald-600',
  FAILED: 'bg-red-500/10 text-red-600',
  CANCELLED: 'bg-amber-500/10 text-amber-600',
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
      <div className="space-y-6">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-32 w-full rounded-xl" />
        <div className="grid grid-cols-1 lg:grid-cols-[1fr,380px] gap-6">
          <div className="space-y-4">
            <Skeleton className="h-48 w-full rounded-xl" />
            <Skeleton className="h-64 w-full rounded-xl" />
          </div>
          <div className="space-y-4">
            <Skeleton className="h-64 w-full rounded-xl" />
            <Skeleton className="h-48 w-full rounded-xl" />
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
    <div className="space-y-6">
      <Button variant="ghost" size="sm" onClick={() => router.back()} className="gap-1.5">
        <ArrowLeft className="h-4 w-4" />
        返回列表
      </Button>

      <div className="dashboard-surface p-4 sm:p-6">
        <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:gap-5">
          <EmployeeAvatar
            employeeType={employee.employee_type}
            size="xl"
            status={employee.status}
          />
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-bold tracking-tight">{employee.name}</h1>
            <p className="text-sm text-muted-foreground mt-1">
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

      <div className="grid grid-cols-1 lg:grid-cols-[1fr,380px] gap-6">
        <div className="space-y-4">
          {runningTask && (
            <div className="dashboard-surface p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold">当前任务</h3>
                <span className="text-xs text-muted-foreground">
                  进行中 {runningTask.started_at ? formatDuration(runningTask.started_at) : ''}
                </span>
              </div>
              <p className="text-base font-medium mb-3">{runningTask.task_name}</p>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted mb-3">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-blue-500 to-cyan-400 transition-all duration-700"
                  style={{ width: `${runningTask.progress_percent}%` }}
                />
              </div>
              <div className="flex justify-between text-sm text-muted-foreground">
                <span>{runningTask.current_step || '处理中…'}</span>
                <span className="font-medium text-blue-600">{runningTask.progress_percent}%</span>
              </div>
            </div>
          )}

          <div className="dashboard-surface p-5">
            <h3 className="text-sm font-semibold mb-4">任务历史</h3>
            {tasks.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">暂无任务记录</p>
            ) : (
              <div className="space-y-2">
                {tasks.slice(0, taskPage * 10).map((task) => (
                  <div
                    key={task.id}
                    className="flex items-center gap-3 rounded-lg border p-3 hover:bg-muted/30 transition-colors"
                  >
                    <span className="text-base shrink-0">
                      {TASK_STATUS_ICON[task.status] || '⏳'}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{task.task_name}</p>
                      <p className="text-xs text-muted-foreground">
                        {task.started_at ? new Date(task.started_at).toLocaleString('zh-CN') : '—'}
                        {task.error_message && (
                          <span className="text-red-500 ml-2">{task.error_message}</span>
                        )}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge className={cn(TASK_STATUS_STYLES[task.status], 'text-[10px]')}>
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
                    className="w-full mt-2 py-2 border border-dashed rounded-lg text-sm text-muted-foreground hover:text-foreground hover:border-foreground/20 transition-colors"
                  >
                    加载更多
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <div className="dashboard-surface p-5">
            <div className="flex items-center gap-2 mb-4">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              <h3 className="text-sm font-semibold">实时日志</h3>
            </div>
            <LiveLog employeeId={employeeId} maxItems={20} className="max-h-[400px]" />
          </div>

          <div className="dashboard-surface p-5">
            <h3 className="text-sm font-semibold mb-3">员工信息</h3>
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
    <div className="flex justify-between gap-4 py-1.5 border-b border-border/50 last:border-0">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="text-right truncate">{value}</span>
    </div>
  )
}

function formatDuration(startedAt: string): string {
  const minutes = Math.floor((Date.now() - new Date(startedAt).getTime()) / 60000)
  if (minutes < 1) return '不到 1 分钟'
  if (minutes < 60) return `${minutes} 分钟`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`
}
