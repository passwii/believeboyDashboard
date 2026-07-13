'use client'

import type { DigitalEmployee } from '@/types/digital-employee'
import { cn } from '@/lib/utils'

interface DigitalEmployeeStatsProps {
  employees: DigitalEmployee[]
}

export function DigitalEmployeeStats({ employees }: DigitalEmployeeStatsProps) {
  const total = employees.length
  const running = employees.filter((e) => e.status === 'RUNNING').length
  const idle = employees.filter((e) => e.status === 'IDLE').length
  const failed = employees.filter((e) => e.status === 'FAILED').length

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <StatCard icon="🤖" label="全部" value={total} />
      <StatCard
        icon={null}
        label="运行中"
        value={running}
        accent="text-blue-600"
        highlight={running > 0}
        pulse={running > 0}
      />
      <StatCard icon="✓" label="空闲" value={idle} accent="text-muted-foreground" />
      <StatCard
        icon="⚠"
        label="异常"
        value={failed}
        accent={failed > 0 ? 'text-red-600' : 'text-emerald-600'}
        highlight={failed > 0}
      />
    </div>
  )
}

function StatCard({
  icon,
  label,
  value,
  accent = 'text-foreground',
  highlight = false,
  pulse = false,
}: {
  icon: string | null
  label: string
  value: number
  accent?: string
  highlight?: boolean
  pulse?: boolean
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-xl border px-4 py-3 transition-colors',
        highlight ? 'border-primary/20 bg-primary/5' : 'border-border bg-card'
      )}
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted/50">
        {pulse ? (
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
          </span>
        ) : (
          <span className="text-sm">{icon}</span>
        )}
      </div>
      <div>
        <p className={cn('text-2xl font-bold tabular-nums leading-none', accent)}>{value}</p>
        <p className="text-xs text-muted-foreground mt-1">{label}</p>
      </div>
    </div>
  )
}
