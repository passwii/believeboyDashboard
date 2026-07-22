'use client'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { OfficeEmployee, DisplayStatus } from '@/lib/digital-employee/office-stream-types'

const STATUS_BADGE: Record<DisplayStatus, { variant: 'info' | 'warning' | 'secondary' | 'destructive' | 'outline'; label: string }> = {
  WORKING: { variant: 'info', label: '在岗' },
  PAUSING: { variant: 'secondary', label: '收尾' },
  IDLE: { variant: 'outline', label: '待命' },
  OFFLINE: { variant: 'outline', label: '离线' },
  FAILED: { variant: 'destructive', label: '失败' },
}

export function OfficeBadge({ employee }: { employee: OfficeEmployee }) {
  const { persona, work_item, display_status, busy_level, virtual_progress, step_label, queued_count, today_done, success_rate } = employee
  const status = STATUS_BADGE[display_status]
  const busy = busy_level === 'BUSY' || busy_level === 'SWAMPED'
  const hero = work_item.project_name
    ? `【${work_item.project_name}】${work_item.report_label ?? ''}`
    : (employee.current_task?.task_name ?? '暂无任务')

  return (
    <div
      className={cn(
        'dashboard-surface u-interactive flex flex-col gap-3 p-4',
        busy && 'ring-1 ring-warning/40 shadow-raised',
        display_status === 'OFFLINE' && 'opacity-60 saturate-50'
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-lg">{persona.emoji}</span>
          <div className="leading-tight">
            <p className="text-sm font-semibold">{employee.name}</p>
            <p className="dashboard-kicker">{persona.tagline}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {busy && <span className="text-xs">🔥</span>}
          <Badge variant={status.variant}>{status.label}</Badge>
        </div>
      </div>

      <div className="min-h-[3.5rem]">
        <p className="dashboard-kicker">正在处理</p>
        <p className="dashboard-display text-foreground text-[clamp(1.25rem,2vw,1.6rem)]">{hero}</p>
      </div>

      <div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-[2800ms] ease-linear"
            style={{ width: `${Math.max(2, virtual_progress)}%` }}
          />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{step_label}</p>
      </div>

      <div className="flex items-center justify-between border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
        <span>今日 {today_done} 件 · 成功率 {Math.round(success_rate * 100)}%</span>
        {queued_count > 0 && <span className="text-warning">排队 {queued_count}</span>}
      </div>
    </div>
  )
}
