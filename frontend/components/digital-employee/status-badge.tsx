'use client'

import type { DigitalEmployeeStatus } from '@/types/digital-employee'
import {
  WarmBadge,
  type WarmBadgeTone,
} from '@/components/dashboard-v2/warm-ledger/controls'

const STATUS_TONES: Record<DigitalEmployeeStatus, WarmBadgeTone> = {
  IDLE: 'neutral',
  RUNNING: 'accent',
  SUCCEEDED: 'positive',
  FAILED: 'negative',
  SUSPENDED: 'accent',
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
    <WarmBadge
      tone={STATUS_TONES[status]}
      className={size === 'sm' ? 'text-[10px]' : undefined}
    >
      {STATUS_LABELS[status]}
    </WarmBadge>
  )
}
