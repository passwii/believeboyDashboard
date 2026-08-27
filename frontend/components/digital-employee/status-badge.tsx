'use client'

import type { DigitalEmployeeStatus } from '@/types/digital-employee'
import { Badge } from '@/components/ui/badge'

const STATUS_STYLES: Record<DigitalEmployeeStatus, string> = {
  IDLE: 'border border-term-border bg-term-bg text-term-faint',
  RUNNING: 'border border-term-accent/40 bg-term-bg text-term-accent',
  SUCCEEDED: 'border border-term-pos/40 bg-term-bg text-term-pos',
  FAILED: 'border border-term-neg/40 bg-term-bg text-term-neg',
  SUSPENDED: 'border border-term-warn/40 bg-term-bg text-term-warn',
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
    <Badge className={`rounded-none border font-mono text-[11px] leading-4 ${STATUS_STYLES[status]} ${size === 'sm' ? 'text-[10px] px-1.5 py-0' : ''}`}>
      {STATUS_LABELS[status]}
    </Badge>
  )
}
