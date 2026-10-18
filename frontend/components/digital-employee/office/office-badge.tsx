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
  WORKING: 'bg-term-accent',
  PAUSING: 'bg-term-warn',
  IDLE: 'bg-term-faint',
  OFFLINE: 'bg-term-border',
  FAILED: 'bg-term-neg',
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
        'group flex cursor-pointer flex-col gap-3 rounded-none border border-term-border bg-term-panel p-4 shadow-none',
        'transition-colors hover:bg-term-hover hover:border-term-border-strong',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-term-accent',
        busy && 'border-term-warn/40',
        failed && 'border-term-neg/30',
        display_status === 'OFFLINE' && 'opacity-60 saturate-50',
      )}
    >
      {/* ── 头部：persona 渐变环头像 + 名字 + 状态 ── */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <div className="relative">
            <span
              className="flex h-10 w-10 items-center justify-center rounded-none border-2 text-xl shadow-none"
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
            <p className="font-mono text-[11px] uppercase tracking-wider text-term-faint">{persona.tagline}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {busy && <span className="text-xs">🔥</span>}
          <Badge variant={status.variant}>{status.label}</Badge>
        </div>
      </div>

      {/* ── HERO 工作事项 ── */}
      <div className="min-h-[3.5rem]">
        <p className="font-mono text-[11px] uppercase tracking-wider text-term-faint">
          {working ? '正在处理' : failed ? '遇到问题' : '当前状态'}
        </p>
        <p className="truncate text-sm font-semibold leading-tight text-term-text">
          {hero}
        </p>
      </div>

      {/* ── 进度条 ── */}
      <div>
        <div className="relative h-1.5 w-full overflow-hidden rounded-none border border-term-border bg-term-bg">
          <div
            className={cn(
              'h-full rounded-none bg-term-accent transition-[width] duration-[2800ms] ease-linear',
              busy && working && 'office-busy-shimmer',
            )}
            style={{ width: `${Math.max(2, virtual_progress)}%` }}
          />
        </div>
        {/* 拟人化状态气泡 */}
        <p className="mt-2 font-mono text-xs leading-4 text-term-muted transition-opacity duration-[var(--duration-very-slow)]">
          {step_label}
        </p>
      </div>

      {/* ── hover 展开：当前步骤细节 ── */}
      <div className="max-h-0 overflow-hidden opacity-0 transition-all duration-[var(--duration-slow)] group-hover:max-h-20 group-hover:opacity-100">
        {employee.current_task && (
          <div className="rounded-none border border-term-border bg-term-bg px-3 py-2 font-mono text-[11px] leading-4 text-term-muted">
            <p>任务：{employee.current_task.task_name}</p>
            <p>进度：{Math.round(virtual_progress)}% · 节奏：{employee.pace.toFixed(1)}x</p>
          </div>
        )}
      </div>

      {/* ── footer 战绩 ── */}
      <div className="flex items-center justify-between border-t border-term-border pt-2 font-mono text-[11px] text-term-faint">
        <span>今日 {today_done} 件 · 成功率 {Math.round(success_rate * 100)}%</span>
        {queued_count > 0 && (
          <span className={cn('font-medium tabular-nums', busy ? 'text-term-warn' : 'text-term-muted')}>
            排队 {queued_count}
          </span>
        )}
      </div>
    </div>
  )
}
