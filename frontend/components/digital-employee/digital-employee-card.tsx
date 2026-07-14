'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { DigitalEmployee, DigitalEmployeeStatus } from '@/types/digital-employee'
import { getPersona, EmployeeAvatar } from './persona'
import { StatusBadge } from './status-badge'
import { HeartbeatDot } from './heartbeat-dot'
import { DataStream } from './data-stream'
import { cn } from '@/lib/utils'

const ACCENT_STYLES: Record<DigitalEmployeeStatus, string> = {
  IDLE: '',
  RUNNING: 'bg-gradient-to-r from-blue-500 via-cyan-400 to-blue-500 de-animate-shimmer',
  SUCCEEDED: 'bg-emerald-500',
  FAILED: 'bg-red-500',
  SUSPENDED: 'bg-amber-500',
}

const AVATAR_RING: Record<DigitalEmployeeStatus, string> = {
  IDLE: '',
  RUNNING: 'ring-2 ring-blue-400/40',
  SUCCEEDED: '',
  FAILED: 'ring-2 ring-red-400/30',
  SUSPENDED: '',
}

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
  const router = useRouter()
  const [isHovered, setIsHovered] = useState(false)
  const persona = getPersona(employee.employee_type)
  const accent = ACCENT_STYLES[employee.status]
  const avatarRing = AVATAR_RING[employee.status]

  function handleInfoClick(e: React.MouseEvent) {
    e.stopPropagation()
    router.push(`/dashboard/ai/digital-employees/${employee.id}`)
  }

  return (
    <div
      className={cn(
        'group relative rounded-2xl border bg-card transition-all duration-300 cursor-pointer',
        'hover:shadow-md hover:-translate-y-0.5 hover:border-primary/20'
      )}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={() => onClick?.(employee.id)}
    >
      {accent && <div className={cn('absolute inset-x-0 top-0 h-0.5 rounded-t-2xl', accent)} />}

      <div className="p-4 space-y-3">
        <div className="flex items-start justify-between">
          <div className="min-w-0 flex-1">
            <h3 className="truncate font-semibold text-sm leading-tight">{employee.name}</h3>
            <p className="text-xs text-muted-foreground truncate mt-0.5">
              {employee.employee_type.replace(/_/g, ' ').toLowerCase()} · {persona.tagline}
            </p>
          </div>
          <button
            onClick={handleInfoClick}
            className={cn(
              'ml-2 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border text-xs font-semibold transition-colors',
              'text-muted-foreground hover:border-blue-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950',
              isHovered ? 'border-blue-200' : 'border-border'
            )}
            title="查看详情"
          >
            ℹ
          </button>
        </div>

        <div className="flex justify-center">
          <div className={cn('transition-all duration-300', avatarRing)}>
            <EmployeeAvatar
              employeeType={employee.employee_type}
              size="lg"
              status={employee.status}
            />
          </div>
        </div>

        <DataStream
          employee={employee}
          currentTask={currentTask}
          variant={getDataVariant(employee.status)}
        />

        <div className="flex items-center justify-between">
          <HeartbeatDot lastSeen={employee.last_heartbeat_at} />
          <StatusBadge status={employee.status} size="sm" />
        </div>
      </div>
    </div>
  )
}
