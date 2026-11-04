'use client'

import type { DigitalEmployee } from '@/types/digital-employee'
import styles from './digital-employee-warm.module.css'

interface DigitalEmployeeStatsProps {
  employees: DigitalEmployee[]
}

export function DigitalEmployeeStats({ employees }: DigitalEmployeeStatsProps) {
  const total = employees.length
  const running = employees.filter((e) => e.status === 'RUNNING').length
  const idle = employees.filter((e) => e.status === 'IDLE').length
  const failed = employees.filter((e) => e.status === 'FAILED').length

  return (
    <div className={styles.statsPanel} data-testid="digital-employee-stats">
      <StatCard label="全部" value={total} />
      <StatCard
        label="运行中"
        value={running}
        tone={running > 0 ? 'accent' : 'neutral'}
      />
      <StatCard label="空闲" value={idle} />
      <StatCard
        label="异常"
        value={failed}
        tone={failed > 0 ? 'negative' : 'positive'}
      />
    </div>
  )
}

function StatCard({
  label,
  value,
  tone = 'neutral',
}: {
  label: string
  value: number
  tone?: 'neutral' | 'accent' | 'positive' | 'negative'
}) {
  return (
    <div className={styles.statCard} data-tone={tone}>
      <p className={styles.statValue}>{value}</p>
      <p className={styles.statLabel}>{label}</p>
    </div>
  )
}
