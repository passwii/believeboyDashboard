'use client'

import type { DateRange } from 'react-day-picker'

import { DateRangePicker, type DateRangePickerChangeMeta } from '@/components/ui/date-picker'
import { cn } from '@/lib/utils'

interface DateRangeFieldProps {
  label?: string
  value?: DateRange
  onChange: (range?: DateRange, meta?: DateRangePickerChangeMeta) => void
  timezone?: string
  className?: string
  triggerClassName?: string
}

export function DateRangeField({
  label,
  value,
  onChange,
  timezone,
  className,
  triggerClassName,
}: DateRangeFieldProps) {
  const content = (
    <DateRangePicker
      value={value}
      onChange={onChange}
      className={cn(
        // BLF-893：console 触发器统一 term 令牌 + 零圆角；h-10 与同排筛选对齐。
        'h-10 w-full border-term-border bg-term-bg font-mono text-xs leading-5 text-term-text shadow-none focus-visible:outline-none focus-visible:border-term-border-strong',
        triggerClassName
      )}
      timezone={timezone}
    />
  )

  if (!label) {
    return <div className={className}>{content}</div>
  }

  return (
    <div className={cn('space-y-2', className)}>
      <div className="font-mono text-[11px] uppercase tracking-wider text-term-muted">{label}</div>
      {content}
    </div>
  )
}
