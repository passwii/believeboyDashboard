'use client'

import type { DigitalEmployee } from '@/types/digital-employee'

interface DigitalEmployeeStatsProps {
  employees: DigitalEmployee[]
}

export function DigitalEmployeeStats({ employees }: DigitalEmployeeStatsProps) {
  const total = employees.length
  const running = employees.filter((e) => e.status === 'RUNNING').length
  const idle = employees.filter((e) => e.status === 'IDLE').length
  const failed = employees.filter((e) => e.status === 'FAILED').length
  const suspended = employees.filter((e) => e.status === 'SUSPENDED').length

  return (
    <div className="flex gap-4">
      <StatCard label="全部" value={total} />
      <StatCard label="运行中" value={running} color="text-blue-600" />
      <StatCard label="空闲" value={idle} color="text-muted-foreground" />
      <StatCard label="异常" value={failed} color="text-destructive" />
      <StatCard label="暂停" value={suspended} color="text-amber-600" />
    </div>
  )
}

function StatCard({ label, value, color = 'text-foreground' }: { label: string; value: number; color?: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-[hsl(var(--sidebar-foreground)/0.06)] bg-[hsl(var(--sidebar-foreground)/0.03)] px-4 py-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={`text-xl font-semibold tabular-nums ${color}`}>{value}</span>
    </div>
  )
}