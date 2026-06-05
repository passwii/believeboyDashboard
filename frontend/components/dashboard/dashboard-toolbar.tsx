'use client'

import { Calendar, CalendarDays, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'

export type ViewMode = 'today' | 'weekly'

interface DashboardToolbarProps {
  mode: ViewMode
  onModeChange: (mode: ViewMode) => void
  onRefresh: () => void
  refreshing?: boolean
  dateLabel?: string
}

export function DashboardToolbar({
  mode,
  onModeChange,
  onRefresh,
  refreshing = false,
  dateLabel,
}: DashboardToolbarProps) {
  return (
    <div className="dashboard-toolbar flex items-center justify-between rounded-xl">
      <div className="inline-flex items-center rounded-lg border border-border/70 bg-[hsl(var(--surface-subtle))] p-1">
        <button
          onClick={() => onModeChange('today')}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-all duration-200',
            mode === 'today'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <Calendar className="h-3.5 w-3.5" />
          今日销售概况
        </button>
        <button
          onClick={() => onModeChange('weekly')}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-all duration-200',
            mode === 'weekly'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <CalendarDays className="h-3.5 w-3.5" />
          近7日概况
        </button>
      </div>

      {dateLabel && (
        <span className="hidden text-xs text-muted-foreground sm:block">
          {dateLabel}
        </span>
      )}

      <button
        onClick={onRefresh}
        disabled={refreshing}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background/60 px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-background hover:text-foreground',
          refreshing && 'opacity-50'
        )}
      >
        <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
        刷新
      </button>
    </div>
  )
}