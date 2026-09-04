'use client'

import { ChevronLeft, ChevronRight } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface MonthNavigationProps {
  value: Date | undefined
  onChange: (date: Date) => void
  onPrev?: () => void
  onNext?: () => void
  formatLabel?: (date: Date) => string
  showCurrentMonth?: boolean
  className?: string
  monthLabel?: string
}

export function MonthNavigation({
  value,
  onChange,
  onPrev,
  onNext,
  formatLabel = (d) => `${d.getFullYear()}年${d.getMonth() + 1}月`,
  showCurrentMonth = true,
  className,
  monthLabel = '月份',
}: MonthNavigationProps) {
  const handlePrev =
    onPrev ||
    (() => {
      if (!value) return
      const prev = new Date(value.getFullYear(), value.getMonth() - 1, 1)
      onChange(prev)
    })

  const handleNext =
    onNext ||
    (() => {
      if (!value) return
      const next = new Date(value.getFullYear(), value.getMonth() + 1, 1)
      onChange(next)
    })

  const isCurrentMonth = () => {
    if (!value) return false
    const now = new Date()
    return value.getFullYear() === now.getFullYear() && value.getMonth() === now.getMonth()
  }

  return (
    <div className={cn('flex items-center gap-1', className)}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={handlePrev}
        disabled={!value}
        className="h-9 w-9 shrink-0"
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>

      <div className="flex min-w-[120px] items-center justify-center gap-2">
        {monthLabel && (
          <span className="text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            {monthLabel}
          </span>
        )}
        <span className="min-w-[80px] text-center text-sm font-medium tabular-nums">
          {value ? formatLabel(value) : '--'}
        </span>
      </div>

      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={handleNext}
        disabled={!value}
        className="h-9 w-9 shrink-0"
      >
        <ChevronRight className="h-4 w-4" />
      </Button>

      {showCurrentMonth && value && !isCurrentMonth() ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onChange(new Date())}
          className="h-8 text-xs"
        >
          本月
        </Button>
      ) : null}
    </div>
  )
}
