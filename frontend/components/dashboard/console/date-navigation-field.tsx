'use client'

import { ChevronLeft, ChevronRight } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { SingleDatePicker } from '@/components/ui/date-picker'
import { cn } from '@/lib/utils'

interface DateNavigationFieldProps {
  label?: string
  value?: Date
  onChange: (date?: Date) => void
  onPrev?: () => void
  onNext?: () => void
  showNav?: boolean
  showToday?: boolean
  className?: string
  triggerClassName?: string
}

export function DateNavigationField({
  label,
  value,
  onChange,
  onPrev,
  onNext,
  showNav = true,
  showToday = false,
  className,
  triggerClassName,
}: DateNavigationFieldProps) {
  const handlePrev = () => {
    if (!value) return
    const prev = new Date(value)
    prev.setDate(prev.getDate() - 1)
    onChange(prev)
  }

  const handleNext = () => {
    if (!value) return
    const next = new Date(value)
    next.setDate(next.getDate() + 1)
    onChange(next)
  }

  const content = (
    <div className="flex items-center gap-1">
      {showNav ? (
        <>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onPrev || handlePrev}
            disabled={!value}
            className="h-9 w-9 shrink-0"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <SingleDatePicker
            value={value}
            onChange={onChange}
            className={cn('h-9 w-[140px] border-border/70 bg-[hsl(var(--surface-soft))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))]', triggerClassName)}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onNext || handleNext}
            disabled={!value}
            className="h-9 w-9 shrink-0"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </>
      ) : (
        <SingleDatePicker
          value={value}
          onChange={onChange}
          className={cn('h-9 w-[140px] border-border/70 bg-[hsl(var(--surface-soft))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))]', triggerClassName)}
        />
      )}
      {showToday && (
        <Button
          type="button"
          variant="secondary"
          onClick={() => onChange(new Date())}
          className="h-9 shrink-0 text-xs"
        >
          今天
        </Button>
      )}
    </div>
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
