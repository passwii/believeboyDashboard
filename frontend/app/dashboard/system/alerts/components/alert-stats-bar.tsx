'use client'

import { Skeleton } from '@/components/ui/skeleton'
import type { AlertStats } from '@/lib/alerts-api'
import { TermKpiTile } from '@/components/terminal/term-controls'

const CARDS = [
  { key: 'total_active', label: '活跃告警', tone: undefined },
  { key: 'critical_count', label: '严重', tone: 'neg' as const },
  { key: 'warning_count', label: '警告', tone: 'warn' as const },
  { key: 'info_count', label: '提示', tone: 'info' as const },
  { key: 'acknowledged_today', label: '今日确认', tone: undefined },
  { key: 'resolved_today', label: '今日解决', tone: 'pos' as const },
] as const

export function AlertStatsBar({ stats }: { stats: AlertStats | null }) {
  return (
    // BLF-838：彩色图标卡换终端 KPI 磁贴（mono 数值 + term 语义色）
    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-6">
      {CARDS.map((c) => {
        const value = stats ? String(stats[c.key]) : ''
        return (
          <TermKpiTile
            key={c.key}
            label={c.label}
            value={value}
            tone={c.tone}
            loading={stats == null}
          />
        )
      })}
    </div>
  )
}

export function AlertStatsBarSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-6">
      {CARDS.map((c) => (
        <Skeleton key={c.key} className="h-14 w-full rounded-none" />
      ))}
    </div>
  )
}
