'use client'
import { useRouter } from 'next/navigation'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { getPersonaGradient, getPersonaBorder } from '@/components/digital-employee/persona'
import type { OfficeEmployee, DisplayStatus } from '@/lib/digital-employee/office-stream-types'

const STATUS_BADGE: Record<DisplayStatus, { variant: 'info' | 'warning' | 'secondary' | 'destructive' | 'outline'; label: string }> = {
  WORKING: { variant: 'info', label: '在岗' },
  PAUSING: { variant: 'secondary', label: '收尾' },
  IDLE: { variant: 'outline', label: '待命' },
  OFFLINE: { variant: 'outline', label: '离线' },
  FAILED: { variant: 'destructive', label: '失败' },
}

/** 状态点颜色 */
const STATUS_DOT: Record<DisplayStatus, string> = {
  WORKING: 'bg-blue-500',
  PAUSING: 'bg-amber-400',
  IDLE: 'bg-muted-foreground/40',
  OFFLINE: 'bg-muted-foreground/20',
  FAILED: 'bg-red-500',
}

export function OfficeBadge({ employee }: { employee: OfficeEmployee }) {
  const router = useRouter()
  const {
    persona, work_item, display_status, busy_level,
    virtual_progress, step_label, queued_count, today_done, success_rate,
  } = employee
  const status = STATUS_BADGE[display_status]
  const busy = busy_level === 'BUSY' || busy_level === 'SWAMPED'
  const failed = display_status === 'FAILED'
  const working = display_status === 'WORKING'
  const hero = work_item.project_name
    ? `【${work_item.project_name}】${work_item.report_label ?? ''}`
    : (employee.current_task?.task_name ?? '暂无任务')

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => router.push(`/dashboard/ai/digital-employees/${employee.employee_id}`)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          router.push(`/dashboard/ai/digital-employees/${employee.employee_id}`)
        }
      }}
      className={cn(
        // 基础
        'dashboard-surface u-interactive group flex cursor-pointer flex-col gap-3 p-4',
        'transition-all duration-300 ease-out',
        // hover 上浮
        'hover:-translate-y-1 hover:shadow-lg',
        'focus-visible:outline-2 focus-visible:outline-primary',
        // 忙碌：光晕环
        busy && 'ring-1 ring-warning/40 shadow-raised',
        // 失败：gentle 红色脉动
        failed && 'office-fail-pulse ring-1 ring-destructive/30',
        // 离线：降饱和压暗
        display_status === 'OFFLINE' && 'opacity-60 saturate-50',
      )}
    >
      {/* ── 头部：persona 渐变环头像 + 名字 + 状态 ── */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <div className="relative">
            <span
              className="flex h-10 w-10 items-center justify-center rounded-xl border-2 text-xl shadow-sm"
              style={{
                background: getPersonaGradient(persona.color_key),
                borderColor: getPersonaBorder(persona.color_key),
              }}
            >
              {persona.emoji}
            </span>
            {/* 状态呼吸点 */}
            <span
              className={cn(
                'absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-background',
                STATUS_DOT[display_status],
                working && 'office-breathe',
              )}
            />
          </div>
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

      {/* ── HERO 工作事项 ── */}
      <div className="min-h-[3.5rem]">
        <p className="dashboard-kicker">
          {working ? '正在处理' : failed ? '遇到问题' : '当前状态'}
        </p>
        <p className="dashboard-display text-foreground text-[clamp(1.25rem,2vw,1.6rem)]">
          {hero}
        </p>
      </div>

      {/* ── 进度条 ── */}
      <div>
        <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              'h-full rounded-full bg-primary transition-[width] duration-[2800ms] ease-linear',
              busy && working && 'office-busy-shimmer',
            )}
            style={{ width: `${Math.max(2, virtual_progress)}%` }}
          />
        </div>
        {/* 拟人化状态气泡 */}
        <p className="mt-2 text-xs text-muted-foreground transition-opacity duration-700">
          {step_label}
        </p>
      </div>

      {/* ── hover 展开：当前步骤细节 ── */}
      <div className="max-h-0 overflow-hidden opacity-0 transition-all duration-300 group-hover:max-h-20 group-hover:opacity-100">
        {employee.current_task && (
          <div className="rounded-lg bg-muted/50 px-3 py-2 text-[11px] text-muted-foreground">
            <p>任务：{employee.current_task.task_name}</p>
            <p>进度：{Math.round(virtual_progress)}% · 节奏：{employee.pace.toFixed(1)}x</p>
          </div>
        )}
      </div>

      {/* ── footer 战绩 ── */}
      <div className="flex items-center justify-between border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
        <span>今日 {today_done} 件 · 成功率 {Math.round(success_rate * 100)}%</span>
        {queued_count > 0 && (
          <span className={cn('font-medium', busy ? 'text-warning' : 'text-muted-foreground')}>
            排队 {queued_count}
          </span>
        )}
      </div>
    </div>
  )
}
