'use client'

import * as React from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'

const HOURS = Array.from({ length: 24 }, (_, i) => i)
const MINUTES = Array.from({ length: 60 }, (_, i) => i)

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export interface TimePickerProps {
  /** 当前选中小时 (0-23) */
  hour: number
  /** 当前选中分钟 (0-59) */
  minute: number
  /** 小时变更回调 */
  onHourChange: (hour: number) => void
  /** 分钟变更回调 */
  onMinuteChange: (minute: number) => void
  /** 可选小时白名单；不在白名单中的小时显示为 disabled。省略则全部可用。 */
  allowedHours?: number[]
  /** 整体禁用 */
  disabled?: boolean
  /** 容器额外类名 */
  className?: string
}

function TimePicker({
  hour,
  minute,
  onHourChange,
  onMinuteChange,
  allowedHours,
  disabled,
  className,
}: TimePickerProps) {
  const allowedSet = React.useMemo(
    () => (allowedHours ? new Set(allowedHours) : null),
    [allowedHours]
  )

  return (
    <div className={cn('flex gap-1.5 items-center', className)}>
      <Select
        value={String(hour)}
        onValueChange={(v) => onHourChange(Number(v))}
        disabled={disabled}
      >
        <SelectTrigger className="w-[80px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {HOURS.map((h) => (
            <SelectItem
              key={h}
              value={String(h)}
              disabled={allowedSet ? !allowedSet.has(h) : undefined}
            >
              {pad(h)}:00
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <span className="text-muted-foreground">:</span>

      <Select
        value={String(minute)}
        onValueChange={(v) => onMinuteChange(Number(v))}
        disabled={disabled}
      >
        <SelectTrigger className="w-[80px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {MINUTES.map((m) => (
            <SelectItem key={m} value={String(m)}>
              {pad(m)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

export { TimePicker }
