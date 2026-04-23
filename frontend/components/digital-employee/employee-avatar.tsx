'use client'

import type { DigitalEmployeeStatus } from '@/types/digital-employee'

interface EmployeeAvatarProps {
  emoji?: string
  imageUrl?: string
  size?: 'sm' | 'md' | 'lg' | 'xl'
  status?: DigitalEmployeeStatus
  className?: string
}

const SIZE_MAP = {
  sm: 'h-8 w-8 text-lg',
  md: 'h-12 w-12 text-2xl',
  lg: 'h-16 w-16 text-4xl',
  xl: 'h-24 w-24 text-6xl',
}

const STATUS_DOT_COLORS: Record<DigitalEmployeeStatus, string> = {
  IDLE: 'bg-muted',
  RUNNING: 'bg-blue-500 animate-pulse',
  SUCCEEDED: 'bg-emerald-500',
  FAILED: 'bg-red-500',
  SUSPENDED: 'bg-amber-500',
}

export function EmployeeAvatar({ emoji = '🤖', size = 'md', status, className = '' }: EmployeeAvatarProps) {
  return (
    <div className={`relative inline-flex ${className}`}>
      <div
        className={`flex items-center justify-center rounded-xl border border-[hsl(var(--sidebar-foreground)/0.08)] bg-[hsl(var(--sidebar-foreground)/0.04)] shadow-sm ${SIZE_MAP[size]}`}
      >
        {emoji}
      </div>
      {status && (
        <span
          className={`absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-background ${STATUS_DOT_COLORS[status]}`}
        />
      )}
    </div>
  )
}