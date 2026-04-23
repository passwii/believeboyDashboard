'use client'

import { useState } from 'react'
import { ArrowLeft, Pause, Play, RefreshCw } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { fetchDigitalEmployee, fetchEmployeeTasks, suspendEmployee, resumeEmployee } from '@/lib/digital-employee-api'
import { EmployeeAvatar } from '@/components/digital-employee/employee-avatar'
import { StatusBadge } from '@/components/digital-employee/status-badge'
import { HeartbeatDot } from '@/components/digital-employee/heartbeat-dot'
import { useEffect } from 'react'

const TYPE_EMOJI: Record<string, string> = {
  AUTO_REPORT_UPLOAD: '📤',
  SCHEDULED_JOB: '⏰',
  RPA_BOT: '🤖',
  AI_AGENT: '💬',
  MONITORING: '📊',
  DATABASE: '🗄️',
  CUSTOM: '⚙️',
}

const TASK_STATUS_STYLES: Record<string, string> = {
  PENDING: 'bg-muted/60 text-muted-foreground',
  RUNNING: 'bg-blue-500/10 text-blue-600',
  SUCCEEDED: 'bg-emerald-500/10 text-emerald-600',
  FAILED: 'bg-red-500/10 text-red-600',
  CANCELLED: 'bg-amber-500/10 text-amber-600',
}

export default function EmployeeDetailPage({ params }: { params: { id: string } }) {
  const router = useRouter()
  const employeeId = parseInt(params.id, 10)

  const [employee, setEmployee] = useState<import('@/types/digital-employee').DigitalEmployee | null>(null)
  const [tasks, setTasks] = useState<import('@/types/digital-employee').DigitalEmployeeTask[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isActing, setIsActing] = useState(false)

  useEffect(() => {
    async function load() {
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
    }
    void load()
  }, [employeeId])

  async function handleSuspend() {
    setIsActing(true)
    try {
      await suspendEmployee(employeeId)
      setEmployee((prev) => prev ? { ...prev, status: 'SUSPENDED' } : null)
    } finally {
      setIsActing(false)
    }
  }

  async function handleResume() {
    setIsActing(true)
    try {
      await resumeEmployee(employeeId)
      setEmployee((prev) => prev ? { ...prev, status: 'IDLE' } : null)
    } finally {
      setIsActing(false)
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-48 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={() => router.back()}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex items-center gap-3">
          <EmployeeAvatar
            emoji={employee.avatar_url || TYPE_EMOJI[employee.employee_type] || '🤖'}
            status={employee.status}
            size="lg"
          />
          <div>
            <h1 className="text-2xl font-semibold">{employee.name}</h1>
            <div className="flex items-center gap-2 mt-1">
              <StatusBadge status={employee.status} />
              <span className="text-sm text-muted-foreground">{employee.employee_type.replace('_', ' ')}</span>
            </div>
          </div>
        </div>
        <div className="ml-auto flex gap-2">
          {employee.status === 'SUSPENDED' ? (
            <Button size="sm" variant="outline" onClick={() => void handleResume()} disabled={isActing}>
              <Play className="h-4 w-4" />
              恢复
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => void handleSuspend()} disabled={isActing}>
              <Pause className="h-4 w-4" />
              暂停
            </Button>
          )}
        </div>
      </div>

      {/* Info Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">基本信息</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {employee.description && (
            <div>
              <p className="text-xs text-muted-foreground">描述</p>
              <p className="text-sm">{employee.description}</p>
            </div>
          )}
          <HeartbeatDot lastSeen={employee.last_heartbeat_at} />
        </CardContent>
      </Card>

      {/* Task History */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">任务历史</CardTitle>
        </CardHeader>
        <CardContent>
          {tasks.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无任务记录</p>
          ) : (
            <div className="space-y-3">
              {tasks.slice(0, 10).map((task) => (
                <div key={task.id} className="flex items-center justify-between rounded-lg border p-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{task.task_name}</p>
                    <p className="text-xs text-muted-foreground">
                      {task.started_at ? new Date(task.started_at).toLocaleString('zh-CN') : '—'}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <Badge className={TASK_STATUS_STYLES[task.status]}>{task.status}</Badge>
                    <span className="text-sm tabular-nums">{task.progress_percent}%</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}