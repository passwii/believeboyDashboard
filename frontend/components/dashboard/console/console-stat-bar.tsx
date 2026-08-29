'use client'

import { cn } from '@/lib/utils'

export interface StatItem {
  label: string
  value: string | number
  color?: 'default' | 'positive' | 'negative' | 'warning'
}

interface ConsoleStatBarProps {
  items: StatItem[]
  className?: string
  gridClassName?: string
}

function getValueColor(item: StatItem) {
  switch (item.color) {
    case 'positive':
      return 'text-emerald-600 dark:text-emerald-400'
    case 'negative':
      return 'text-term-neg'
    case 'warning':
      return 'text-term-warn'
    default:
      return 'text-foreground'
  }
}

export function ConsoleStatBar({ items, className, gridClassName }: ConsoleStatBarProps) {
  return (
    <div className={cn('flex flex-wrap gap-4', className)}>
      {items.map((item, i) => (
        <div key={i} className={cn('flex items-center gap-2', gridClassName)}>
          <span className="text-xs text-muted-foreground">{item.label}</span>
          <span className={cn('font-semibold tabular-nums', getValueColor(item))}>
            {typeof item.value === 'number' ? item.value.toLocaleString() : item.value}
          </span>
        </div>
      ))}
    </div>
  )
}
