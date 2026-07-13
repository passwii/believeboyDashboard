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
        'h-10 w-full border-border/70 bg-[hsl(var(--surface-soft))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))]',
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
      <div className="text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </div>
      {content}
    </div>
  )
}
