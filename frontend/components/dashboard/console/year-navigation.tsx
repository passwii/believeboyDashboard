'use client'

import { ChevronLeft, ChevronRight } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface YearNavigationProps {
  value: number
  onChange: (year: number) => void
  formatLabel?: (year: number) => string
  className?: string
  labelClassName?: string
  yearSuffix?: string
}

export function YearNavigation({
  value,
  onChange,
  formatLabel = (y) => `${y}年`,
  className,
  labelClassName,
  yearSuffix = '年',
}: YearNavigationProps) {
  return (
    <div className={cn('flex items-center gap-1', className)}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => onChange(value - 1)}
        aria-label="上一年"
        className="h-9 w-9 shrink-0"
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>

      <div className="flex min-w-[80px] items-center justify-center">
        <span className={cn('text-sm font-medium tabular-nums', labelClassName)}>
          {formatLabel(value)}
        </span>
      </div>

      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => onChange(value + 1)}
        aria-label="下一年"
        className="h-9 w-9 shrink-0"
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  )
}
