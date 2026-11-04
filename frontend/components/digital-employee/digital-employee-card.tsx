'use client'

import { ChevronRight } from 'lucide-react'
import type { DigitalEmployee, DigitalEmployeeStatus } from '@/types/digital-employee'
import { getPersona, EmployeeAvatar } from './persona'
import { StatusBadge } from './status-badge'
import { HeartbeatDot } from './heartbeat-dot'
import { DataStream } from './data-stream'
import styles from './digital-employee-warm.module.css'

function getDataVariant(
  status: DigitalEmployeeStatus
): 'default' | 'success' | 'error' | 'warning' {
  if (status === 'SUCCEEDED') return 'success'
  if (status === 'FAILED') return 'error'
  if (status === 'SUSPENDED') return 'warning'
  return 'default'
}

interface DigitalEmployeeCardProps {
  employee: DigitalEmployee
  onClick?: (id: number) => void
  currentTask?: {
    task_name: string
    progress_percent: number
    current_step: string | null
    status: string
  } | null
}

export function DigitalEmployeeCard({ employee, onClick, currentTask }: DigitalEmployeeCardProps) {
  const persona = getPersona(employee.employee_type)

  return (
    <div
      role="button"
      tabIndex={0}
      className={styles.employeeRow}
      onClick={() => onClick?.(employee.id)}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onClick?.(employee.id)
      }}
    >
      <span className={styles.employeeAvatarWrap}>
        <EmployeeAvatar
          employeeType={employee.employee_type}
          size="md"
          status={employee.status}
        />
      </span>

      <span className={styles.employeeIdentity}>
        <span className={styles.employeeName}>{employee.name}</span>
        <span className={styles.employeeSubline}>
          {employee.employee_type.replace(/_/g, ' ').toLowerCase()} · {persona.tagline}
        </span>
      </span>

      <span className={styles.employeeStream}>
        <DataStream
          employee={employee}
          currentTask={currentTask}
          variant={getDataVariant(employee.status)}
        />
      </span>

      <span className={styles.employeeRowMeta}>
        <span className={styles.employeeStatus}>
          <HeartbeatDot lastSeen={employee.last_heartbeat_at} />
          <StatusBadge status={employee.status} size="sm" />
        </span>
        <ChevronRight className={styles.chevron} aria-hidden="true" />
      </span>
    </div>
  )
}
