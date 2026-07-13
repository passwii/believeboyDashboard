'use client'

import type { DigitalEmployeeStatus } from '@/types/digital-employee'
import { Badge } from '@/components/ui/badge'

const STATUS_STYLES: Record<DigitalEmployeeStatus, string> = {
  IDLE: 'bg-muted/60 text-muted-foreground',
  RUNNING: 'bg-primary/10 text-primary animate-pulse',
  SUCCEEDED: 'bg-emerald-500/10 text-emerald-600',
  FAILED: 'bg-destructive/10 text-destructive',
  SUSPENDED: 'bg-amber-500/10 text-amber-600',
}

const STATUS_LABELS: Record<DigitalEmployeeStatus, string> = {
  IDLE: '空闲',
  RUNNING: '运行中',
  SUCCEEDED: '成功',
  FAILED: '失败',
  SUSPENDED: '暂停',
}

interface StatusBadgeProps {
  status: DigitalEmployeeStatus
  size?: 'sm' | 'md'
}

export function StatusBadge({ status, size = 'md' }: StatusBadgeProps) {
  return (
    <Badge className={`${STATUS_STYLES[status]} ${size === 'sm' ? 'text-[10px] px-1.5 py-0' : ''}`}>
      {STATUS_LABELS[status]}
    </Badge>
  )
}
