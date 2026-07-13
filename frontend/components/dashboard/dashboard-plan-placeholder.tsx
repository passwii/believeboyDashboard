'use client'

import { CalendarDays } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { DataCard, DataCardHeader, DataCardContent } from '@/components/ui/data-card'

const ghostRows = [
  { width: 'w-32', time: '09:00' },
  { width: 'w-44', time: '14:30' },
  { width: 'w-28', time: '明天' },
]

export function DashboardPlanPlaceholder() {
  return (
    <DataCard>
      <DataCardHeader
        title="计划事项"
        action={
          <Badge variant="secondary" className="bg-secondary/10 text-secondary text-[10px]">
            即将推出
          </Badge>
        }
      />
      <DataCardContent className="space-y-5">
        {/* Empty state */}
        <div className="flex flex-col items-center justify-center py-6 text-center">
          <div className="mb-4 rounded-xl bg-[hsl(var(--surface-subtle))] p-3.5 text-muted-foreground dark:bg-[hsl(var(--surface-soft))]">
            <CalendarDays className="h-6 w-6" />
          </div>
          <h3 className="text-sm font-semibold text-foreground">暂无计划事项</h3>
          <p className="mt-1.5 max-w-[200px] text-xs leading-relaxed text-muted-foreground">
            计划管理功能即将推出，届时可在此查看待办事项和日程安排。
          </p>
        </div>

        {/* Ghost rows */}
        <div className="space-y-2 opacity-40">
          {ghostRows.map((row, index) => (
            <div
              key={index}
              className="flex items-center gap-3 rounded-md bg-[hsl(var(--surface-subtle))] px-4 py-3 dark:bg-[hsl(var(--surface-soft))]"
            >
              <div className="h-2 w-2 shrink-0 rounded-full bg-muted-foreground/40" />
              <div className={`h-3 rounded-full bg-muted-foreground/20 ${row.width}`} />
              <div className="ml-auto shrink-0 text-[10px] text-muted-foreground/60">
                {row.time}
              </div>
            </div>
          ))}
        </div>
      </DataCardContent>
    </DataCard>
  )
}
