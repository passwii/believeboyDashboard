'use client'

import { useState } from 'react'
import type { DigitalEmployee, DigitalEmployeeStatus } from '@/types/digital-employee'
import { PERSONA_MAP } from './persona'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardHeader,
} from '@/components/ui/card'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

const STATUS_STYLES: Record<DigitalEmployeeStatus, { badge: string; mood: string; label: string; pulse: string }> = {
  IDLE: {
    badge: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
    mood: '💤',
    label: '待命中',
    pulse: '',
  },
  RUNNING: {
    badge: 'bg-blue-50 text-blue-600 dark:bg-blue-950 dark:text-blue-400 animate-pulse',
    mood: '⚡',
    label: '工作中',
    pulse: 'ring-2 ring-blue-400/40 de-running-glow',
  },
  SUCCEEDED: {
    badge: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400',
    mood: '✅',
    label: '已完成',
    pulse: '',
  },
  FAILED: {
    badge: 'bg-red-50 text-red-600 dark:bg-red-950 dark:text-red-400 animate-pulse',
    mood: '❌',
    label: '遇到问题',
    pulse: 'ring-2 ring-red-400/30 de-animate-shake',
  },
  SUSPENDED: {
    badge: 'bg-amber-50 text-amber-600 dark:bg-amber-950 dark:text-amber-400',
    mood: '⏸',
    label: '已暂停',
    pulse: '',
  },
}

interface DigitalEmployeeCardProps {
  employee: DigitalEmployee
  onClick?: (id: number) => void
  displayMode?: boolean
}

// Shimmer pulse animation for running state
function StatusOrb({ status }: { status: DigitalEmployeeStatus }) {
  const config = STATUS_STYLES[status]
  return (
    <div className={cn('relative inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium', config.badge)}>
      <span className="relative flex h-2 w-2">
        {status === 'RUNNING' && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
        )}
        <span className={cn('relative inline-flex rounded-full h-2 w-2')} />
      </span>
      <span>{config.label}</span>
      <span className="ml-0.5 text-sm">{config.mood}</span>
    </div>
  )
}

function PersonaAvatar({ employee }: { employee: DigitalEmployee }) {
  const persona = PERSONA_MAP[employee.employee_type] || PERSONA_MAP.CUSTOM
  const statusStyle = STATUS_STYLES[employee.status as DigitalEmployeeStatus]
  const emoji = employee.avatar_url || persona.emoji

  return (
    <div className={cn('flex items-center gap-3', statusStyle.pulse)}>
      {/* Avatar */}
      <div className="relative shrink-0">
        <div
          className={cn(
            'flex h-14 w-14 items-center justify-center rounded-2xl border-2 bg-gradient-to-br shadow-sm',
            `from-${persona.color.split('-')[1]}-50 to-${persona.color.split('-')[1]}-100`,
            'border-' + persona.color.split('-')[1] + '-200/60',
            'dark:from-' + persona.color.split('-')[1] + '-950 dark:to-' + persona.color.split('-')[1] + '-900',
          )}
          style={{
            background: `linear-gradient(135deg, hsl(var(--${persona.color.split('-')[1]}-500)/.08) 0%, hsl(var(--${persona.color.split('-')[1]}-500)/.03) 100%)`,
          }}
        >
          <span className="text-3xl">{emoji}</span>
        </div>
        {/* Mood orb */}
        <span className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full border-2 border-background text-xs shadow-sm" title={statusStyle.label}>
          {statusStyle.mood}
        </span>
      </div>

      {/* Name + tagline */}
      <div className="min-w-0 flex-1">
        <h3 className="truncate font-semibold text-sm leading-tight">{employee.name}</h3>
        <p className="text-xs text-muted-foreground truncate mt-0.5">{persona.tagline}</p>
        <StatusOrb status={employee.status} />
      </div>
    </div>
  )
}

function ThoughtBubble({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <div className="relative rounded-xl bg-gradient-to-r from-primary/5 to-primary/0 px-3 py-2 text-xs text-muted-foreground border border-primary/10">
      <span className="absolute -top-2 left-3 text-primary/30 text-lg leading-none">💭</span>
      <p className="pl-4 line-clamp-2 leading-relaxed">{message}</p>
    </div>
  )
}

function ActionBar({ employee }: { employee: DigitalEmployee }) {
  if (employee.status === 'SUSPENDED') {
    return (
      <div className="flex items-center justify-between pt-3 border-t border-border/50">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>⏸</span>
          <span>已暂停，等待恢复指令</span>
        </div>
        <Button size="sm" variant="outline" className="h-7 text-xs gap-1">
          ▶ 恢复
        </Button>
      </div>
    )
  }
  if (employee.status === 'FAILED') {
    return (
      <div className="flex items-center justify-between pt-3 border-t border-destructive/20">
        <div className="flex items-center gap-1.5 text-xs text-destructive">
          <span>⚠</span>
          <span>任务异常中断</span>
        </div>
        <Button size="sm" variant="destructive" className="h-7 text-xs gap-1">
          🔄 重试
        </Button>
      </div>
    )
  }
  if (employee.status === 'RUNNING') {
    return (
      <div className="flex items-center justify-between pt-3 border-t border-border/50">
        <div className="flex items-center gap-1.5 text-xs text-blue-600 dark:text-blue-400">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
          </span>
          <span>正在执行任务</span>
        </div>
        <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground gap-1">
          ⏸ 暂停
        </Button>
      </div>
    )
  }
  return (
    <div className="flex items-center justify-between pt-3 border-t border-border/50">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span>✓</span>
        <span>一切正常</span>
      </div>
      <div className="flex items-center gap-1">
        <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground">详情</Button>
        <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground">日志</Button>
      </div>
    </div>
  )
}

function LastActiveBar({ lastSeen }: { lastSeen: string | null }) {
  const minutes = lastSeen ? Math.floor((Date.now() - new Date(lastSeen).getTime()) / 60000) : null
  const label = minutes === null ? '暂无数据' : minutes < 1 ? '刚刚' : minutes < 60 ? `${minutes}分钟前` : `${Math.floor(minutes / 60)}小时前`
  const color = minutes === null ? 'bg-slate-400' : minutes < 1 ? 'bg-emerald-500' : minutes < 30 ? 'bg-blue-500' : minutes < 120 ? 'bg-amber-500' : 'bg-red-500'

  return (
    <div className="flex items-center gap-2">
      <div className={cn('h-1.5 w-1.5 rounded-full', color)} />
      <span className="text-xs text-muted-foreground">最后活跃: {label}</span>
    </div>
  )
}

export function DigitalEmployeeCard({ employee, onClick, displayMode = false }: DigitalEmployeeCardProps) {
  const [isHovered, setIsHovered] = useState(false)
  const persona = PERSONA_MAP[employee.employee_type] || PERSONA_MAP.CUSTOM

  return (
    <div
      className={cn(
        'group relative rounded-2xl border bg-card transition-all duration-300',
        'hover:shadow-lg hover:-translate-y-0.5 hover:border-primary/20',
        displayMode ? 'min-h-[220px]' : '',
      )}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={() => onClick?.(employee.id)}
    >
      {/* Top accent line */}
      <div
        className={cn(
          'absolute inset-x-0 top-0 h-0.5 rounded-t-2xl transition-all duration-500',
          employee.status === 'RUNNING'
            ? 'bg-gradient-to-r from-blue-500 via-cyan-400 to-blue-500 de-animate-shimmer'
            : isHovered
              ? 'opacity-100'
              : 'opacity-0',
        )}
        style={
          employee.status !== 'RUNNING' && isHovered
            ? {
                background: `linear-gradient(90deg, hsl(var(--${persona.color.split('-')[1]}-500)/.6) 0%, hsl(var(--${persona.color.split('-')[1]}-500)/.2) 100%)`,
              }
            : undefined
        }
      />

      <div className={cn('p-4 space-y-3', displayMode && 'p-5')}>
        {/* Persona Header */}
        <PersonaAvatar employee={employee} />

        {/* Thought bubble (simulated latest log) */}
        <ThoughtBubble message={employee.description ? `📋 ${employee.description}` : null} />

        {/* Stats row */}
        <div className="grid grid-cols-2 gap-2">
          <MiniStat label="类型" value={employee.employee_type.replace('_', ' ')} />
          <MiniStat
            label="最后更新"
            value={employee.last_heartbeat_at
              ? new Date(employee.last_heartbeat_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
              : '—'}
          />
        </div>

        {/* Last active bar */}
        <LastActiveBar lastSeen={employee.last_heartbeat_at} />

        {/* Action bar */}
        <ActionBar employee={employee} />

        {/* Hover reveal: click hint */}
        <div
          className={cn(
            'text-center text-xs text-muted-foreground/40 transition-all duration-300',
            isHovered ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1',
          )}
        >
          点击查看详情 →
        </div>
      </div>
    </div>
  )
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/40 px-2.5 py-1.5">
      <p className="text-[10px] text-muted-foreground leading-none mb-0.5">{label}</p>
      <p className="text-xs font-medium truncate">{value}</p>
    </div>
  )
}