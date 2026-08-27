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
    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
      <StatCard icon="🤖" label="全部" value={total} />
      <StatCard
        icon={null}
        label="运行中"
        value={running}
        accent="text-term-accent"
        highlight={running > 0}
        pulse={running > 0}
      />
      <StatCard icon="✓" label="空闲" value={idle} accent="text-term-muted" />
      <StatCard
        icon="⚠"
        label="异常"
        value={failed}
        accent={failed > 0 ? 'text-term-neg' : 'text-term-pos'}
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
        'flex items-center gap-3 rounded-none border px-3 py-2.5 shadow-none transition-colors',
        highlight ? 'border-term-accent/40 bg-term-bg' : 'border-term-border bg-term-panel'
      )}
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-none border border-term-border bg-term-raised">
        {pulse ? (
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-term-accent/35 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-term-accent" />
          </span>
        ) : (
          <span className="text-sm">{icon}</span>
        )}
      </div>
      <div>
        <p className={cn('font-mono text-xl font-bold tabular-nums leading-none', accent)}>{value}</p>
        <p className="font-mono text-xs leading-4 text-term-faint mt-1">{label}</p>
      </div>
    </div>
  )
}
