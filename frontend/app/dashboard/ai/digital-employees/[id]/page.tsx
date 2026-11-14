'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { ArrowLeft, Pause, Play } from 'lucide-react'
import { useParams, useRouter } from 'next/navigation'
import {
  WarmBadge,
  WarmButton,
  type WarmBadgeTone,
} from '@/components/dashboard-v2/warm-ledger/controls'
import {
  fetchDigitalEmployee,
  fetchEmployeeTasks,
  DigitalEmployeeNotFoundError,
  suspendEmployee,
  resumeEmployee,
} from '@/lib/digital-employee-api'
import { EmployeeAvatar, getPersona } from '@/components/digital-employee/persona'
import { StatusBadge } from '@/components/digital-employee/status-badge'
import { HeartbeatDot } from '@/components/digital-employee/heartbeat-dot'
import { LiveLog } from '@/components/digital-employee/live-log'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import type {
  DigitalEmployee,
  DigitalEmployeeTask,
  TaskStatus,
} from '@/types/digital-employee'
import styles from '@/components/digital-employee/digital-employee-warm.module.css'

const TASK_STATUS_TONES: Record<TaskStatus, WarmBadgeTone> = {
  PENDING: 'neutral',
  RUNNING: 'accent',
  SUCCEEDED: 'positive',
  FAILED: 'negative',
  CANCELLED: 'neutral',
}

export default function EmployeeDetailPage() {
  const routeParams = useParams<{ id: string }>()
  const router = useRouter()
  const employeeId = parseInt(routeParams.id, 10)

  const [employeeData, setEmployeeData] = useState<DigitalEmployee | null>(null)
  const employee = employeeData?.id === employeeId ? employeeData : null
  const employeeRef = useRef(employee)
  employeeRef.current = employee
  const loadRequestIdRef = useRef(0)
  const [tasks, setTasks] = useState<DigitalEmployeeTask[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<{ employeeId: number; message: string } | null>(null)
  const [notFoundEmployeeId, setNotFoundEmployeeId] = useState<number | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isActing, setIsActing] = useState(false)
  const [taskPage, setTaskPage] = useState(1)

  const load = useCallback(async () => {
    const requestId = ++loadRequestIdRef.current
    if (!employeeRef.current) setIsLoading(true)
    setLoadError(null)
    setNotFoundEmployeeId(null)
    try {
      const [nextEmployee, taskData] = await Promise.all([
        fetchDigitalEmployee(employeeId),
        fetchEmployeeTasks(employeeId),
      ])
      if (requestId !== loadRequestIdRef.current) return
      setEmployeeData(nextEmployee)
      setTasks(taskData.items)
      setLoadError(null)
    } catch (error) {
      if (requestId !== loadRequestIdRef.current) return
      if (error instanceof DigitalEmployeeNotFoundError) {
        setEmployeeData(null)
        setTasks([])
        setNotFoundEmployeeId(employeeId)
      } else if (!employeeRef.current) {
        setLoadError({
          employeeId,
          message: error instanceof Error ? error.message : '加载数字员工失败',
        })
      }
    } finally {
      if (requestId === loadRequestIdRef.current) setIsLoading(false)
    }
  }, [employeeId])

  const refreshFromHeader = useCallback(async () => {
    setIsRefreshing(true)
    try {
      await load()
    } finally {
      setIsRefreshing(false)
    }
  }, [load])

  useHeaderRefresh(refreshFromHeader, { loading: isLoading || isRefreshing })

  useEffect(() => {
    void load()
    const interval = setInterval(() => {
      if (employeeRef.current) void load()
    }, 15000)
    return () => {
      clearInterval(interval)
      loadRequestIdRef.current += 1
    }
  }, [load])

  async function handleSuspend() {
    setIsActing(true)
    try {
      await suspendEmployee(employeeId)
      setEmployeeData((previous) =>
        previous ? { ...previous, status: 'SUSPENDED' } : null
      )
    } finally {
      setIsActing(false)
    }
  }

  async function handleResume() {
    setIsActing(true)
    try {
      await resumeEmployee(employeeId)
      setEmployeeData((previous) => (previous ? { ...previous, status: 'IDLE' } : null))
    } finally {
      setIsActing(false)
    }
  }

  const currentLoadError =
    loadError?.employeeId === employeeId ? loadError.message : null
  const isNotFound = notFoundEmployeeId === employeeId

  if (!employee && currentLoadError) {
    return (
      <div
        className={styles.page}
        data-warm-digital-employee-detail="true"
      >
        <div className={styles.missingState} role="alert">
          加载失败：{currentLoadError}
        </div>
        <WarmButton type="button" variant="secondary" onClick={() => void load()}>
          重试
        </WarmButton>
      </div>
    )
  }

  if (!employee && isNotFound) {
    return (
      <div
        className={styles.page}
        data-warm-digital-employee-detail="true"
      >
        <div className={styles.missingState}>数字员工不存在</div>
      </div>
    )
  }

  if (!employee) {
    return (
      <div
        className={styles.page}
        data-warm-digital-employee-detail="true"
        aria-busy={isLoading || undefined}
      >
        <div className={styles.missingState} role="status">
          正在加载数字员工...
        </div>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div
        className={styles.page}
        data-warm-digital-employee-detail="true"
        aria-busy="true"
      >
        <div className={`${styles.skeleton} ${styles.backRow}`} />
        <div className={`${styles.skeleton} ${styles.skeletonRow}`} />
        <div className={styles.skeletonLayout}>
          <div className={styles.skeletonRoster}>
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className={`${styles.skeleton} ${styles.skeletonRow}`} />
            ))}
          </div>
          <div className={styles.skeletonRail}>
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className={`${styles.skeleton} ${styles.skeletonRow}`} />
            ))}
          </div>
        </div>
      </div>
    )
  }

  const persona = getPersona(employee.employee_type)
  const runningTask = tasks.find((task) => task.status === 'RUNNING')

  return (
    <div
      className={styles.page}
      data-warm-digital-employee-detail="true"
      aria-busy={isRefreshing || undefined}
    >
      <div className={styles.backRow}>
        <WarmButton
          type="button"
          variant="quiet"
          onClick={() => router.back()}
          aria-label="返回列表"
        >
          <ArrowLeft aria-hidden="true" />
          返回列表
        </WarmButton>
      </div>

      <section
        className={`${styles.panel} ${styles.profilePanel}`}
        aria-label={employee.name}
        data-testid="digital-employee-profile"
      >
        <div className={styles.profileMain}>
          <EmployeeAvatar
            employeeType={employee.employee_type}
            size="xl"
            status={employee.status}
          />
          <div className={styles.profileCopy}>
            <h1 className={styles.employeeNameTitle}>{employee.name}</h1>
            <p className={styles.profileSubline}>
              {employee.employee_type.replace(/_/g, ' ').toLowerCase()} · {persona.tagline}
            </p>
            <div className={styles.profileSignals}>
              <StatusBadge status={employee.status} />
              <HeartbeatDot lastSeen={employee.last_heartbeat_at} />
            </div>
          </div>
        </div>

        <div className={styles.profileActions}>
          {employee.status === 'SUSPENDED' ? (
            <WarmButton
              type="button"
              variant="primary"
              onClick={() => void handleResume()}
              disabled={isActing}
              loading={isActing}
              loadingLabel="正在恢复数字员工"
            >
              <Play aria-hidden="true" />
              恢复
            </WarmButton>
          ) : (
            <WarmButton
              type="button"
              variant="secondary"
              onClick={() => void handleSuspend()}
              disabled={isActing}
              loading={isActing}
              loadingLabel="正在暂停数字员工"
            >
              <Pause aria-hidden="true" />
              暂停
            </WarmButton>
          )}
        </div>
      </section>

      <div className={styles.detailGrid} data-testid="digital-employee-detail-grid">
        <div className={styles.detailMain}>
          {runningTask ? (
            <section className={styles.panel} aria-label="当前任务">
              <div className={styles.panelHeader}>
                <h2 className={styles.panelTitle}>当前任务</h2>
                <span className={styles.panelMeta}>
                  进行中 {runningTask.started_at ? formatDuration(runningTask.started_at) : ''}
                </span>
              </div>
              <div className={styles.currentTaskBody}>
                <p className={styles.currentTaskName}>{runningTask.task_name}</p>
                <div className={styles.currentTaskProgress}>
                  <span style={{ width: `${runningTask.progress_percent}%` }} />
                </div>
                <div className={styles.currentTaskFooter}>
                  <span>{runningTask.current_step || '处理中…'}</span>
                  <strong>{runningTask.progress_percent}%</strong>
                </div>
              </div>
            </section>
          ) : null}

          <section className={styles.panel} aria-label="任务历史">
            <div className={styles.panelHeader}>
              <h2 className={styles.panelTitle}>任务历史</h2>
            </div>
            {tasks.length === 0 ? (
              <div className={styles.panelEmpty}>
                <p>暂无任务记录</p>
              </div>
            ) : (
              <>
                <div className={styles.taskList}>
                  {tasks.slice(0, taskPage * 10).map((task) => (
                    <div key={task.id} className={styles.taskRow}>
                      <div className={styles.taskCopy}>
                        <p className={styles.taskName}>{task.task_name}</p>
                        <p className={styles.taskMeta}>
                          {task.started_at
                            ? new Date(task.started_at).toLocaleString('zh-CN')
                            : '—'}
                          {task.error_message ? (
                            <span className={styles.taskError}>{task.error_message}</span>
                          ) : null}
                        </p>
                      </div>
                      <div className={styles.taskStatusGroup}>
                        <WarmBadge tone={TASK_STATUS_TONES[task.status]}>
                          {task.status}
                        </WarmBadge>
                        {task.status === 'RUNNING' ? (
                          <span>{task.progress_percent}%</span>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
                {tasks.length > taskPage * 10 ? (
                  <div className={styles.loadMore}>
                    <WarmButton
                      type="button"
                      variant="quiet"
                      onClick={() => setTaskPage((page) => page + 1)}
                    >
                      加载更多
                    </WarmButton>
                  </div>
                ) : null}
              </>
            )}
          </section>
        </div>

        <div className={styles.detailRail}>
          <section className={styles.panel} aria-label="实时日志">
            <div className={styles.panelHeader}>
              <h2 className={styles.panelTitle}>实时日志</h2>
            </div>
            <div className={styles.panelBody}>
              <LiveLog
                employeeId={employeeId}
                maxItems={20}
                className={styles.railLog}
              />
            </div>
          </section>

          <section className={styles.panel} aria-label="员工信息">
            <div className={styles.panelHeader}>
              <h2 className={styles.panelTitle}>员工信息</h2>
            </div>
            <div className={styles.infoList}>
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
              {employee.description ? (
                <InfoRow label="描述" value={employee.description} />
              ) : null}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.infoRow}>
      <span className={styles.infoLabel}>{label}</span>
      <span className={styles.infoValue}>{value}</span>
    </div>
  )
}

function formatDuration(startedAt: string): string {
  const minutes = Math.floor((Date.now() - new Date(startedAt).getTime()) / 60000)
  if (minutes < 1) return '不到 1 分钟'
  if (minutes < 60) return `${minutes} 分钟`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`
}
