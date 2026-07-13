'use client'

import type { DigitalEmployeeStatus } from '@/types/digital-employee'

interface ProgressBarProps {
  value: number
  status: DigitalEmployeeStatus
  size?: 'sm' | 'md'
}

const STATUS_COLORS: Record<DigitalEmployeeStatus, string> = {
  IDLE: 'bg-muted',
  RUNNING: 'bg-blue-500',
  SUCCEEDED: 'bg-emerald-500',
  FAILED: 'bg-red-500',
  SUSPENDED: 'bg-amber-500',
}

export function ProgressBar({ value, status, size = 'md' }: ProgressBarProps) {
  return (
    <div
      className={`w-full rounded-full bg-[hsl(var(--sidebar-foreground)/0.08)] ${size === 'sm' ? 'h-1' : 'h-1.5'}`}
    >
      <div
        className={`h-full rounded-full transition-all duration-500 ease-out ${STATUS_COLORS[status]}`}
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  )
}
